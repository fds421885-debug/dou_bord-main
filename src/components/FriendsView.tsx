import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  BookOpen,
  Check,
  CheckCircle2,
  Clock,
  Gift,
  Loader2,
  MessageCircle,
  Search,
  Send,
  Trash2,
  Trophy,
  UserCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useMyQuizzes } from '../roomQuizzes';
import {
  acceptSharedFriendQuizToMyQuizzes,
  cancelOutgoingFriendRequest,
  ensureDirectChatThread,
  getAcceptedSharedQuizIds,
  makePairId,
  markDirectChatRead,
  removeFriendship,
  resolveEffectiveLeaderboardUser,
  respondToFriendRequest,
  sendDirectTextMessage,
  sendQuizToFriend,
  subscribeChatMessages,
} from '../social';
import type {
  DirectChatDoc,
  DirectMessageDoc,
  FriendRequestDoc,
  FriendshipDoc,
  LeaderboardUserEntry,
  MyQuiz,
  UserProfile,
} from '../types';
import { playDuoSound } from './DuoIcons';
import { LeaderboardUserStatsModal } from './LeaderboardUserStatsModal';
import { PWAInstallButton } from './PWAInstallButton';

interface Props {
  profile: UserProfile;
  resetEpoch: number;
  leaderboardUsers: LeaderboardUserEntry[];
  friendships: FriendshipDoc[];
  incomingRequests: FriendRequestDoc[];
  outgoingRequests: FriendRequestDoc[];
  directChats: DirectChatDoc[];
  selectedFriendUid: string | null;
  onSelectFriendUid: (uid: string | null) => void;
  onGoToLeaderboard: () => void;
  onGoToMyQuizzes: () => void;
}

function formatShortTime(ms: number): string {
  if (!ms) return '';
  try {
    return new Intl.DateTimeFormat('ar-SA', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(ms));
  } catch {
    return '';
  }
}

export const FriendsView: React.FC<Props> = ({
  profile,
  resetEpoch,
  leaderboardUsers,
  friendships,
  incomingRequests,
  outgoingRequests,
  directChats,
  selectedFriendUid,
  onSelectFriendUid,
  onGoToLeaderboard,
  onGoToMyQuizzes,
}) => {
  const { myQuizzes } = useMyQuizzes(profile.uid);
  const [messages, setMessages] = useState<DirectMessageDoc[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [textInput, setTextInput] = useState('');
  const [sendingMsg, setSendingMsg] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmUnfriendUid, setConfirmUnfriendUid] = useState<string | null>(null);

  // Send Quiz modal state
  const [quizPickerOpen, setQuizPickerOpen] = useState(false);
  const [quizSearch, setQuizSearch] = useState('');
  const [sendingQuizId, setSendingQuizId] = useState<string | null>(null);

  // Import shared quiz state
  const [acceptedMap, setAcceptedMap] = useState<Record<string, string>>(() =>
    getAcceptedSharedQuizIds(profile.uid)
  );
  const [importingSharedId, setImportingSharedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statsModalUser, setStatsModalUser] = useState<LeaderboardUserEntry | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const showNotice = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 4000);
  };

  const leaderboardByUid = useMemo(() => {
    const map = new Map<string, LeaderboardUserEntry>();
    for (const u of leaderboardUsers) {
      map.set(u.uid, resolveEffectiveLeaderboardUser(u, resetEpoch));
    }
    return map;
  }, [leaderboardUsers, resetEpoch]);

  const chatsByPairId = useMemo(() => {
    const map = new Map<string, DirectChatDoc>();
    for (const c of directChats) map.set(c.id, c);
    return map;
  }, [directChats]);

  const friendItems = useMemo(() => {
    return friendships
      .map((f) => {
        const friendUid = f.uids.find((id) => id !== profile.uid) || '';
        const lbEntry = leaderboardByUid.get(friendUid);
        const friendName = lbEntry?.fullNameQuad || f.names?.[friendUid] || 'صديق';
        const chatId = makePairId(profile.uid, friendUid);
        const chat = chatsByPairId.get(chatId) || null;
        const myReadAt = Number(chat?.readAtMsByUid?.[profile.uid] || 0);
        const lastMsgAt = Number(chat?.lastMessageAtMs || 0);
        const isUnread =
          Boolean(chat) &&
          lastMsgAt > myReadAt &&
          Boolean(chat?.lastSenderId) &&
          chat?.lastSenderId !== profile.uid;
        return {
          pairId: f.id,
          friendUid,
          friendName,
          lbEntry,
          chat,
          isUnread,
          sortTs: lastMsgAt || f.createdAtMs || 0,
        };
      })
      .filter((item) => Boolean(item.friendUid))
      .sort((a, b) => b.sortTs - a.sortTs);
  }, [friendships, profile.uid, leaderboardByUid, chatsByPairId]);

  // Auto-select first friend if none chosen and we have friends on desktop/load
  useEffect(() => {
    if (!selectedFriendUid && friendItems.length > 0) {
      // Keep unselected on narrow screens? Selecting first provides immediate chat visibility cleanly!
      onSelectFriendUid(friendItems[0].friendUid);
    }
  }, [selectedFriendUid, friendItems, onSelectFriendUid]);

  const activeFriend = useMemo(
    () => friendItems.find((f) => f.friendUid === selectedFriendUid) || null,
    [friendItems, selectedFriendUid]
  );

  const activeChatId = activeFriend
    ? makePairId(profile.uid, activeFriend.friendUid)
    : selectedFriendUid
    ? makePairId(profile.uid, selectedFriendUid)
    : null;

  // Ensure chat thread & subscribe messages when an active friend is selected
  useEffect(() => {
    if (!activeChatId || !activeFriend) {
      setMessages([]);
      setLoadingMsgs(false);
      setChatError(null);
      return;
    }
    let alive = true;
    setLoadingMsgs(true);
    setChatError(null);

    void ensureDirectChatThread({
      myUid: profile.uid,
      myName: profile.fullNameQuad,
      friendUid: activeFriend.friendUid,
      friendName: activeFriend.friendName,
    }).catch((err) => {
      console.error('ensureDirectChatThread error', err);
    });

    const unsub = subscribeChatMessages(
      activeChatId,
      profile.uid,
      (list) => {
        if (!alive) return;
        setMessages(list);
        setLoadingMsgs(false);
        setChatError(null);
      },
      (err) => {
        if (!alive) return;
        setLoadingMsgs(false);
        const msg = String((err as { message?: string })?.message || '');
        setChatError(
          /permission/i.test(msg)
            ? 'قواعد الأمان للمحادثات تحتاج تحديثاً في Firebase أو جارٍ تجهيز غرفة المحادثة.'
            : 'تعذر تحميل رسائل المحادثة حالياً، تأكد من الاتصال.'
        );
      }
    );
    return () => {
      alive = false;
      unsub();
    };
  }, [activeChatId, activeFriend?.friendUid, activeFriend?.friendName, profile.uid, profile.fullNameQuad]);

  // Mark chat read whenever opened or new message arrives in open chat
  useEffect(() => {
    if (!activeFriend?.chat) return;
    if (activeFriend.isUnread) {
      void markDirectChatRead(activeFriend.chat, profile.uid).catch(() => undefined);
    }
  }, [activeFriend, messages.length, profile.uid]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, activeChatId]);

  const pendingIncoming = useMemo(
    () => incomingRequests.filter((r) => r.status === 'pending'),
    [incomingRequests]
  );
  const pendingOutgoing = useMemo(
    () => outgoingRequests.filter((r) => r.status === 'pending'),
    [outgoingRequests]
  );

  const handleRespond = async (req: FriendRequestDoc, accept: boolean) => {
    setBusyId(req.id);
    try {
      await respondToFriendRequest({
        request: req,
        accept,
        myUid: profile.uid,
        myName: profile.fullNameQuad,
      });
      playDuoSound(accept ? 'correct' : 'pop');
      if (accept) {
        onSelectFriendUid(req.fromUid);
        showNotice(`تم قبول صداقة ${req.fromName}!`);
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleSendText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeFriend || !textInput.trim() || sendingMsg) return;
    const msgText = textInput;
    setTextInput('');
    setSendingMsg(true);
    try {
      await sendDirectTextMessage({
        myUid: profile.uid,
        myName: profile.fullNameQuad,
        friendUid: activeFriend.friendUid,
        friendName: activeFriend.friendName,
        text: msgText,
      });
      setChatError(null);
      playDuoSound('pop');
    } catch (err) {
      console.error('sendDirectTextMessage error', err);
      setTextInput(msgText);
      const errMsg = String((err as { message?: string })?.message || '');
      showNotice(
        /permission/i.test(errMsg)
          ? 'تعذر الإرسال بسبب صلاحيات قاعدة البيانات (يرجى التأكد من نشر قواعد الأمان المحدثة).'
          : 'تعذر إرسال الرسالة، تأكد من الاتصال وحاول مجدداً.'
      );
    } finally {
      setSendingMsg(false);
    }
  };

  const handleSendQuiz = async (quiz: MyQuiz) => {
    if (!activeFriend || sendingQuizId) return;
    setSendingQuizId(quiz.id);
    try {
      const partsCount = await sendQuizToFriend({
        myUid: profile.uid,
        myName: profile.fullNameQuad,
        friendUid: activeFriend.friendUid,
        friendName: activeFriend.friendName,
        quiz,
      });
      setQuizPickerOpen(false);
      playDuoSound('correct');
      showNotice(
        partsCount > 1
          ? `تم إرسال الاختبار "${quiz.title}" مقسماً إلى ${partsCount} أجزاء إلى ${activeFriend.friendName}!`
          : `تم إرسال الاختبار "${quiz.title}" إلى ${activeFriend.friendName}!`
      );
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'تعذر إرسال الاختبار.');
    } finally {
      setSendingQuizId(null);
    }
  };

  const handleImportSharedQuiz = async (msg: DirectMessageDoc) => {
    const meta = msg.quizShare;
    if (!meta?.sharedQuizDocId || importingSharedId) return;
    setImportingSharedId(meta.sharedQuizDocId);
    try {
      const res = await acceptSharedFriendQuizToMyQuizzes({
        myUid: profile.uid,
        sharedQuizDocId: meta.sharedQuizDocId,
        fallbackTitle: meta.quizTitle,
      });
      setAcceptedMap(getAcceptedSharedQuizIds(profile.uid));
      playDuoSound('correct');
      showNotice(`تمت إضافة "${res.title}" (${res.questionCount} سؤال) إلى قائمة اختباراتي!`);
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'تعذر استيراد الاختبار.');
    } finally {
      setImportingSharedId(null);
    }
  };

  const filteredQuizzesForShare = useMemo(() => {
    const q = quizSearch.trim().toLowerCase();
    if (!q) return myQuizzes;
    return myQuizzes.filter((item) => item.title.toLowerCase().includes(q));
  }, [myQuizzes, quizSearch]);

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-6 py-5 sm:py-7 flex flex-col gap-5" dir="rtl">
      {/* Header */}
      <div className="duo-card p-4 sm:p-5 bg-white border-2 border-[#E5E5E5] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-[#1CB0F6] border-2 border-b-4 border-[#1899D6] text-white flex items-center justify-center shrink-0">
            <Users className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-lg sm:text-xl font-black text-[#3C3C3C]">
              قائمة الأصدقاء والمحادثات
            </h1>
            <p className="text-xs font-bold text-[#777777]">
              راسل أصدقاءك مباشرة، وأرسل لهم اختباراتك ليضيفوها إلى قائمة اختباراتهم ويختبروا عليها
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PWAInstallButton />
          <button
            type="button"
            onClick={onGoToLeaderboard}
            className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#FFF4CC] border-2 border-b-4 border-[#FFC800] text-[#9A6B00] text-xs font-black cursor-pointer"
          >
            <Trophy className="w-4 h-4" />
            <span>إضافة أصدقاء من لوحة الشرف</span>
          </button>
        </div>
      </div>

      {notice && (
        <div className="p-3 rounded-2xl bg-[#D7FFB8] border-2 border-[#58CC02] text-xs sm:text-sm font-black text-[#46A302]">
          {notice}
        </div>
      )}

      {/* Pending Incoming Requests */}
      {pendingIncoming.length > 0 && (
        <div className="duo-card p-4 bg-[#F0F9FF] border-2 border-[#1CB0F6] flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm font-black text-[#1899D6]">
            <UserPlus className="w-5 h-5" />
            <span>طلبات صداقة واردة ({pendingIncoming.length})</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {pendingIncoming.map((req) => (
              <div
                key={req.id}
                className="p-3 rounded-2xl bg-white border-2 border-[#BCE8FF] flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <p className="text-xs sm:text-sm font-black text-[#3C3C3C] truncate">
                    {req.fromName}
                  </p>
                  <span className="text-[11px] font-bold text-[#777777]">طلب صداقة معلق</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    disabled={busyId === req.id}
                    onClick={() => void handleRespond(req, true)}
                    className="duo-btn flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>قبول</span>
                  </button>
                  <button
                    type="button"
                    disabled={busyId === req.id}
                    onClick={() => void handleRespond(req, false)}
                    className="duo-btn px-2.5 py-1.5 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#EA2B2B] text-xs font-black cursor-pointer"
                  >
                    رفض
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pending Outgoing Requests Strip */}
      {pendingOutgoing.length > 0 && (
        <div className="rounded-2xl border border-[#E5E5E5] bg-[#FAFAFA] px-4 py-2.5 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-black text-[#777777] flex items-center gap-1">
            <Clock className="w-3.5 h-3.5 text-[#FFC800]" />
            طلبات أرسلتها وتنتظر الموافقة:
          </span>
          {pendingOutgoing.map((req) => (
            <span
              key={req.id}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-white border border-[#E5E5E5] font-bold text-[#3C3C3C]"
            >
              <span>{req.toName}</span>
              <button
                type="button"
                onClick={() => void cancelOutgoingFriendRequest(profile.uid, req.toUid)}
                className="text-[#EA2B2B] hover:underline font-black cursor-pointer"
                title="إلغاء الطلب"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Main Split Workspace: Friends List + Chat Box */}
      {friendItems.length === 0 ? (
        <div className="duo-card p-10 text-center flex flex-col items-center gap-3 bg-white">
          <Users className="w-12 h-12 text-[#1CB0F6]" />
          <h2 className="text-base sm:text-lg font-black text-[#3C3C3C]">
            لا يوجد أصدقاء في قائمتك حتى الآن
          </h2>
          <p className="text-xs sm:text-sm font-bold text-[#777777] max-w-md">
            افتح «لوحة الشرف» واضغط «أضف كصديق» بجانب اسم أي طالب، وبمجرد قبوله سيظهر هنا لتبدأ مراسلته وإرسال الاختبارات له فوراً.
          </p>
          <button
            type="button"
            onClick={onGoToLeaderboard}
            className="duo-btn flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#1CB0F6] border-2 border-b-4 border-[#1899D6] text-white text-sm font-black cursor-pointer mt-1"
          >
            <Trophy className="w-4 h-4" />
            <span>الانتقال إلى لوحة الشرف</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* Friends Sidebar */}
          <div className="lg:col-span-4 duo-card bg-white border-2 border-[#E5E5E5] p-3 flex flex-col gap-2">
            <div className="px-2 py-1 flex items-center justify-between text-xs font-black text-[#777777]">
              <span>أصدقائي ({friendItems.length})</span>
            </div>
            <div className="flex flex-col gap-2 max-h-[62vh] overflow-y-auto">
              {friendItems.map((item) => {
                const isSelected = activeFriend?.friendUid === item.friendUid;
                const initials = item.friendName
                  .trim()
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((w) => w[0] || '')
                  .join('');
                return (
                  <div
                    key={item.pairId}
                    className={`rounded-2xl border-2 p-3 transition-colors ${
                      isSelected
                        ? 'bg-[#E6F7FF] border-[#1CB0F6]'
                        : item.isUnread
                        ? 'bg-[#F4FFE8] border-[#58CC02]'
                        : 'bg-white border-[#E5E5E5] hover:border-[#1CB0F6]/60'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectFriendUid(item.friendUid)}
                      className="w-full flex items-center gap-2.5 text-right cursor-pointer"
                    >
                      <div className="w-10 h-10 rounded-full bg-[#1CB0F6] text-white font-black text-xs flex items-center justify-center shrink-0 relative">
                        {initials || '؟'}
                        {item.isUnread && (
                          <span className="w-3 h-3 rounded-full bg-[#58CC02] border-2 border-white absolute -top-0.5 -right-0.5" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs sm:text-sm font-black text-[#3C3C3C] truncate">
                            {item.friendName}
                          </span>
                          {item.chat?.lastMessageAtMs ? (
                            <span className="text-[10px] font-bold text-[#777777] shrink-0">
                              {formatShortTime(item.chat.lastMessageAtMs)}
                            </span>
                          ) : null}
                        </div>
                        <p
                          className={`text-[11px] truncate mt-0.5 ${
                            item.isUnread ? 'font-black text-[#46A302]' : 'font-bold text-[#777777]'
                          }`}
                        >
                          {item.chat?.lastMessageText || 'ابدأ المحادثة الآن...'}
                        </p>
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Active Chat Column */}
          <div className="lg:col-span-8 duo-card bg-white border-2 border-[#E5E5E5] flex flex-col h-[70vh] min-h-[460px] overflow-hidden">
            {activeFriend ? (
              <>
                {/* Chat Top Bar */}
                <div className="p-3.5 sm:p-4 border-b-2 border-[#E5E5E5] bg-[#FAFAFA] flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-9 h-9 rounded-full bg-[#58CC02] text-white font-black text-xs flex items-center justify-center shrink-0">
                      <UserCheck className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-sm sm:text-base font-black text-[#3C3C3C] truncate">
                        {activeFriend.friendName}
                      </h2>
                      {activeFriend.lbEntry && (
                        <p className="text-[11px] font-bold text-[#777777]">
                          صحيح: {activeFriend.lbEntry.correctCount} • دقة:{' '}
                          {activeFriend.lbEntry.statsSnapshot?.accuracyPct || 0}%
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setQuizSearch('');
                        setQuizPickerOpen(true);
                      }}
                      className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#A560E8] border-2 border-b-4 border-[#8938D6] text-white text-xs font-black cursor-pointer"
                    >
                      <Gift className="w-3.5 h-3.5" />
                      <span>إرسال اختبار</span>
                    </button>
                    {activeFriend.lbEntry && (
                      <button
                        type="button"
                        onClick={() => setStatsModalUser(activeFriend.lbEntry || null)}
                        className="duo-btn flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer"
                      >
                        <BarChart3 className="w-3.5 h-3.5 text-[#1CB0F6]" />
                        <span>إحصائياته</span>
                      </button>
                    )}
                    {confirmUnfriendUid === activeFriend.friendUid ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={async () => {
                            await removeFriendship(profile.uid, activeFriend.friendUid);
                            setConfirmUnfriendUid(null);
                            onSelectFriendUid(null);
                            showNotice('تمت إزالة الصداقة.');
                          }}
                          className="px-2.5 py-1.5 rounded-xl bg-[#FF4B4B] text-white text-[11px] font-black cursor-pointer"
                        >
                          تأكيد الإزالة
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmUnfriendUid(null)}
                          className="px-2 py-1.5 rounded-xl bg-white border border-[#E5E5E5] text-[11px] font-black text-[#777777] cursor-pointer"
                        >
                          إلغاء
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmUnfriendUid(activeFriend.friendUid)}
                        className="p-2 rounded-xl text-[#777777] hover:text-[#EA2B2B] hover:bg-[#FFDFE0]/50 cursor-pointer"
                        title="إزالة من الأصدقاء"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Messages Stream */}
                <div className="flex-1 overflow-y-auto p-3.5 sm:p-4 bg-[#F8FAFC] flex flex-col gap-2.5">
                  {chatError && (
                    <div className="p-3 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-xs font-extrabold text-[#EA2B2B]">
                      {chatError}
                    </div>
                  )}
                  {loadingMsgs ? (
                    <div className="m-auto flex flex-col items-center gap-2 text-xs font-black text-[#777777]">
                      <Loader2 className="w-6 h-6 animate-spin text-[#1CB0F6]" />
                      <span>جاري تحميل المحادثة...</span>
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="m-auto text-center flex flex-col items-center gap-2 max-w-xs">
                      <MessageCircle className="w-10 h-10 text-[#1CB0F6]" />
                      <p className="text-sm font-black text-[#3C3C3C]">
                        ابدأ محادثتك مع {activeFriend.friendName}
                      </p>
                      <p className="text-xs font-bold text-[#777777]">
                        يمكنك إرسال رسائل نصية فورية أو إهداء اختبار كامل من «اختباراتي» بضغطة واحدة!
                      </p>
                    </div>
                  ) : (
                    messages.map((msg) => {
                      const isMine = msg.senderId === profile.uid;
                      const quizMeta = msg.quizShare;
                      const alreadyAccepted = quizMeta?.sharedQuizDocId
                        ? Boolean(acceptedMap[quizMeta.sharedQuizDocId])
                        : false;
                      const isImportingThis =
                        quizMeta?.sharedQuizDocId &&
                        importingSharedId === quizMeta.sharedQuizDocId;

                      return (
                        <div
                          key={msg.id}
                          className={`flex flex-col ${isMine ? 'items-start' : 'items-end'}`}
                        >
                          <div
                            className={`max-w-[85%] sm:max-w-[75%] rounded-2xl px-3.5 py-2.5 border-2 ${
                              msg.type === 'quiz_share'
                                ? isMine
                                  ? 'bg-[#F8F3FF] border-[#A560E8] text-[#3C3C3C]'
                                  : 'bg-white border-[#A560E8] text-[#3C3C3C] shadow-sm'
                                : isMine
                                ? 'bg-[#D7FFB8] border-[#58CC02] text-[#2F6A01]'
                                : 'bg-white border-[#E5E5E5] text-[#3C3C3C]'
                            }`}
                          >
                            {msg.type === 'quiz_share' && quizMeta ? (
                              <div className="flex flex-col gap-2">
                                <div className="flex items-center gap-2">
                                  <div className="w-9 h-9 rounded-xl bg-[#A560E8] text-white flex items-center justify-center shrink-0">
                                    <BookOpen className="w-4 h-4" />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="block text-[10px] font-black text-[#8938D6]">
                                      {isMine ? 'أرسلت اختباراً' : 'أرسل لك اختباراً هديه'}
                                    </span>
                                    <p className="text-xs sm:text-sm font-black text-[#3C3C3C]">
                                      {quizMeta.quizTitle}
                                    </p>
                                    <span className="text-[11px] font-bold text-[#777777]">
                                      {quizMeta.questionCount} سؤال
                                    </span>
                                  </div>
                                </div>

                                {!isMine && (
                                  <div className="pt-1 border-t border-[#E5E5E5] flex flex-wrap items-center gap-2">
                                    {alreadyAccepted ? (
                                      <>
                                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-[#D7FFB8] text-[#46A302] text-xs font-black">
                                          <CheckCircle2 className="w-3.5 h-3.5" />
                                          <span>تمت الإضافة لاختباراتي</span>
                                        </span>
                                        <button
                                          type="button"
                                          onClick={onGoToMyQuizzes}
                                          className="duo-btn px-3 py-1 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer"
                                        >
                                          الذهاب للاختبار ←
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={Boolean(importingSharedId)}
                                        onClick={() => void handleImportSharedQuiz(msg)}
                                        className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer disabled:opacity-60"
                                      >
                                        {isImportingThis ? (
                                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        ) : (
                                          <Check className="w-3.5 h-3.5" />
                                        )}
                                        <span>استلام وإضافة إلى اختباراتي</span>
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <p className="text-xs sm:text-sm font-bold whitespace-pre-wrap break-words leading-relaxed">
                                {msg.text}
                              </p>
                            )}

                            <span className="block text-[10px] font-bold opacity-60 mt-1 text-left">
                              {formatShortTime(msg.createdAtMs)}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Chat Composer */}
                <form
                  onSubmit={(e) => void handleSendText(e)}
                  className="p-3 bg-white border-t-2 border-[#E5E5E5] flex items-center gap-2"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setQuizSearch('');
                      setQuizPickerOpen(true);
                    }}
                    className="p-2.5 rounded-xl bg-[#F3E8FF] hover:bg-[#E9D5FF] text-[#8938D6] cursor-pointer shrink-0"
                    title="إرسال اختبار من اختباراتي"
                  >
                    <Gift className="w-5 h-5" />
                  </button>
                  <input
                    type="text"
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                    placeholder={`اكتب رسالة إلى ${activeFriend.friendName}...`}
                    maxLength={2000}
                    className="flex-1 px-3.5 py-2.5 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#1CB0F6] focus:bg-white outline-none text-sm font-bold text-[#3C3C3C]"
                  />
                  <button
                    type="submit"
                    disabled={sendingMsg || !textInput.trim()}
                    className="duo-btn flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-xs sm:text-sm font-black cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    {sendingMsg ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                    <span className="hidden sm:inline">إرسال</span>
                  </button>
                </form>
              </>
            ) : (
              <div className="m-auto p-8 text-center text-sm font-black text-[#777777]">
                اختر صديقاً من القائمة لفتح المحادثة
              </div>
            )}
          </div>
        </div>
      )}

      {/* Share Quiz Picker Modal */}
      {quizPickerOpen && activeFriend && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-3 sm:p-5"
          dir="rtl"
        >
          <div className="duo-card max-w-lg w-full bg-white rounded-3xl border-2 border-[#E5E5E5] shadow-2xl flex flex-col max-h-[85vh] overflow-hidden">
            <div className="p-4 border-b-2 border-[#E5E5E5] flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Gift className="w-5 h-5 text-[#A560E8]" />
                <h3 className="text-sm sm:text-base font-black text-[#3C3C3C]">
                  إرسال اختبار إلى {activeFriend.friendName}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setQuizPickerOpen(false)}
                className="p-1.5 rounded-xl text-[#777777] hover:bg-[#F3F4F6] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3 border-b border-[#E5E5E5]">
              <div className="relative">
                <Search className="w-4 h-4 text-[#777777] absolute right-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={quizSearch}
                  onChange={(e) => setQuizSearch(e.target.value)}
                  placeholder="ابحث في اختباراتك..."
                  className="w-full pr-9 pl-3 py-2 rounded-xl bg-[#F7F7F7] border border-[#E5E5E5] focus:border-[#A560E8] outline-none text-xs font-bold"
                />
              </div>
            </div>

            <div className="p-3 overflow-y-auto flex flex-col gap-2 flex-1">
              {filteredQuizzesForShare.length === 0 ? (
                <div className="p-6 text-center text-xs font-bold text-[#777777]">
                  لا توجد اختبارات مطابقة في قائمة «اختباراتي». أنشئ أو الصق اختباراً أولاً ثم أرسله!
                </div>
              ) : (
                filteredQuizzesForShare.map((qz) => (
                  <div
                    key={qz.id}
                    className="p-3 rounded-2xl border-2 border-[#E5E5E5] hover:border-[#A560E8] flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs sm:text-sm font-black text-[#3C3C3C] truncate">
                        {qz.title}
                      </p>
                      <span className="text-[11px] font-bold text-[#777777]">
                        {qz.questions.length} سؤال
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={Boolean(sendingQuizId)}
                      onClick={() => void handleSendQuiz(qz)}
                      className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#A560E8] border-2 border-b-4 border-[#8938D6] text-white text-xs font-black cursor-pointer shrink-0 disabled:opacity-60"
                    >
                      {sendingQuizId === qz.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                      <span>إرسال</span>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Friend Full Stats Modal */}
      {statsModalUser && (
        <LeaderboardUserStatsModal
          user={statsModalUser}
          relation="friend"
          onClose={() => setStatsModalUser(null)}
          onOpenChat={(u) => {
            setStatsModalUser(null);
            onSelectFriendUid(u.uid);
          }}
        />
      )}
    </div>
  );
};
