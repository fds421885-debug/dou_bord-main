import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from './firestoreTracked';
import { db } from './firebase';
import { cleanQuestions, createMyQuizzesAutoSplit, LIMITS, prepareQuestionsForFirestore } from './myQuizzes';
import { computeQuizStats } from './quizStats';
import { decodeMyQuizFromFirestore } from './quizTable';
import type {
  DirectChatDoc,
  DirectMessageDoc,
  FriendRequestDoc,
  FriendshipDoc,
  LeaderboardMetaDoc,
  LeaderboardStatsSnapshot,
  LeaderboardUserEntry,
  MyQuiz,
  QuizAttempt,
  QuizQuestion,
  SharedFriendQuizDoc,
} from './types';

/**
 * نقطة بداية التصفير الأولى للوحة الشرف بحيث تبدأ الحسابات من الصفر من الآن فصاعداً
 * (المحاولات السابقة لهذا الطابع الزمني لا تُحتسب، ويمكن للمبرمج التصفير في أي وقت لاحقاً)
 */
export const INITIAL_LEADERBOARD_EPOCH = 1795407000000;

const EPOCH_CACHE_KEY = 'duoboard_leaderboard_epoch_v1';
const ACCEPTED_SHARED_PREFIX = 'duoboard_accepted_shared_';

export function makePairId(uid1: string, uid2: string): string {
  return [uid1, uid2].sort().join('__');
}

export function makeFriendRequestId(fromUid: string, toUid: string): string {
  return `${fromUid}__${toUid}`;
}

export function getCachedLeaderboardEpoch(): number {
  try {
    const raw = localStorage.getItem(EPOCH_CACHE_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= INITIAL_LEADERBOARD_EPOCH) return n;
    }
  } catch {
    // Ignore storage issues
  }
  return INITIAL_LEADERBOARD_EPOCH;
}

export function setCachedLeaderboardEpoch(epoch: number): void {
  try {
    if (Number.isFinite(epoch) && epoch > 0) {
      localStorage.setItem(EPOCH_CACHE_KEY, String(epoch));
    }
  } catch {
    // Ignore storage issues
  }
}

export function getEffectiveResetEpoch(meta: LeaderboardMetaDoc | null | undefined): number {
  const remoteEpoch = Number(meta?.resetEpoch || 0);
  return Math.max(INITIAL_LEADERBOARD_EPOCH, Number.isFinite(remoteEpoch) ? remoteEpoch : 0);
}

export function makeEmptyStatsSnapshot(): LeaderboardStatsSnapshot {
  return {
    accuracyPct: 0,
    skippedAnswers: 0,
    bestPct: 0,
    worstPct: 0,
    latestPct: 0,
    volatilityStdDev: 0,
    rangePct: 0,
    stabilityLabel: 'غير كافٍ للقياس',
    trendDirection: 'flat',
    trendDeltaPct: 0,
    avgSecPerQuestion: 0,
    totalDurationSec: 0,
    currentHighStreak: 0,
    bestHighStreak: 0,
    bestTimeSlotLabel: null,
    bestWeekdayLabel: null,
    timeSlots: [],
    weekdays: [],
    recentPoints: [],
    quizRows: [],
    typeBreakdown: {
      mcqTotal: 0,
      mcqCorrect: 0,
      tableTotal: 0,
      tableCorrect: 0,
      withLawsTotal: 0,
      withLawsCorrect: 0,
    },
  };
}

export function filterAttemptsForEpoch(attempts: QuizAttempt[], resetEpoch: number): QuizAttempt[] {
  const cutoff = Math.max(INITIAL_LEADERBOARD_EPOCH, resetEpoch);
  return attempts.filter((a) => Number(a.finishedAt || 0) >= cutoff);
}

export function buildLeaderboardStatsSnapshot(
  attempts: QuizAttempt[],
  resetEpoch: number
): {
  correctCount: number;
  wrongCount: number;
  totalQuestions: number;
  attemptsCount: number;
  statsSnapshot: LeaderboardStatsSnapshot;
} {
  const scoped = filterAttemptsForEpoch(attempts, resetEpoch);
  if (scoped.length === 0) {
    return {
      correctCount: 0,
      wrongCount: 0,
      totalQuestions: 0,
      attemptsCount: 0,
      statsSnapshot: makeEmptyStatsSnapshot(),
    };
  }

  const computed = computeQuizStats(scoped);
  const recentPoints = computed.points.slice(-24).map((p) => ({
    index: p.index,
    title: p.title.slice(0, 80),
    finishedAt: p.finishedAt,
    dateLabel: p.dateLabel,
    timeLabel: p.timeLabel,
    pct: p.pct,
    movingAvgPct: p.movingAvgPct,
    correct: p.correct,
    wrong: p.wrong,
    total: p.total,
    durationSec: p.durationSec,
    secPerQ: p.secPerQ,
  }));

  return {
    correctCount: computed.correctAnswers,
    wrongCount: computed.wrongAnswers + computed.skippedAnswers,
    totalQuestions: computed.totalQuestions,
    attemptsCount: computed.attemptsCount,
    statsSnapshot: {
      accuracyPct: computed.accuracyPct,
      skippedAnswers: computed.skippedAnswers,
      bestPct: computed.bestPct,
      worstPct: computed.worstPct,
      latestPct: computed.latestPct,
      volatilityStdDev: computed.volatilityStdDev,
      rangePct: computed.rangePct,
      stabilityLabel: computed.stabilityLabel,
      trendDirection: computed.trendDirection,
      trendDeltaPct: computed.trendDeltaPct,
      avgSecPerQuestion: computed.avgSecPerQuestion,
      totalDurationSec: computed.totalDurationSec,
      currentHighStreak: computed.currentHighStreak,
      bestHighStreak: computed.bestHighStreak,
      bestTimeSlotLabel: computed.bestTimeSlot?.label || null,
      bestWeekdayLabel: computed.bestWeekday?.label || null,
      timeSlots: computed.timeSlots.map((s) => ({
        id: s.id,
        label: s.label,
        rangeLabel: s.rangeLabel,
        attempts: s.attempts,
        questions: s.questions,
        correct: s.correct,
        wrong: s.wrong,
        avgPct: s.avgPct,
        avgSecPerQ: s.avgSecPerQ,
        isBest: s.isBest,
      })),
      weekdays: computed.weekdays.map((d) => ({
        dayIndex: d.dayIndex,
        label: d.label,
        attempts: d.attempts,
        questions: d.questions,
        correct: d.correct,
        avgPct: d.avgPct,
        isBest: d.isBest,
      })),
      recentPoints,
      quizRows: computed.quizRows.slice(0, 15).map((r) => ({
        key: r.key,
        title: r.title.slice(0, 80),
        attempts: r.attempts,
        questions: r.questions,
        correct: r.correct,
        wrong: r.wrong,
        avgPct: r.avgPct,
        bestPct: r.bestPct,
        latestPct: r.latestPct,
        deltaPct: r.deltaPct,
        avgSecPerQ: r.avgSecPerQ,
      })),
      typeBreakdown: { ...computed.typeBreakdown },
    },
  };
}

export function resolveEffectiveLeaderboardUser(
  entry: LeaderboardUserEntry,
  activeResetEpoch: number
): LeaderboardUserEntry {
  const cutoff = Math.max(INITIAL_LEADERBOARD_EPOCH, activeResetEpoch);
  if (Number(entry.epoch || 0) < cutoff) {
    return {
      ...entry,
      epoch: cutoff,
      correctCount: 0,
      wrongCount: 0,
      totalQuestions: 0,
      attemptsCount: 0,
      statsSnapshot: makeEmptyStatsSnapshot(),
    };
  }
  return entry;
}

export type LeaderboardSortKey = 'correct' | 'accuracy' | 'total';

export function sortLeaderboardUsers(
  users: LeaderboardUserEntry[],
  sortBy: LeaderboardSortKey = 'correct'
): LeaderboardUserEntry[] {
  return [...users].sort((a, b) => {
    if (sortBy === 'accuracy') {
      const accDiff = (b.statsSnapshot?.accuracyPct || 0) - (a.statsSnapshot?.accuracyPct || 0);
      if (accDiff !== 0) return accDiff;
      if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
    } else if (sortBy === 'total') {
      if (b.totalQuestions !== a.totalQuestions) return b.totalQuestions - a.totalQuestions;
      if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
    } else {
      if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
      const accDiff = (b.statsSnapshot?.accuracyPct || 0) - (a.statsSnapshot?.accuracyPct || 0);
      if (accDiff !== 0) return accDiff;
      if (b.totalQuestions !== a.totalQuestions) return b.totalQuestions - a.totalQuestions;
    }
    return a.fullNameQuad.localeCompare(b.fullNameQuad, 'ar');
  });
}

/* ===================== مزامنة لوحة الشرف ===================== */

export async function ensureLeaderboardPresence(
  uid: string,
  fullNameQuad: string,
  activeResetEpoch?: number
): Promise<void> {
  if (!uid || !fullNameQuad.trim()) return;
  const epoch = Math.max(INITIAL_LEADERBOARD_EPOCH, activeResetEpoch || getCachedLeaderboardEpoch());
  const ref = doc(db, 'leaderboardUsers', uid);
  const snap = await getDoc(ref);

  if (snap.exists()) {
    const data = snap.data() as LeaderboardUserEntry;
    const needsReset = Number(data.epoch || 0) < epoch;
    const nameChanged = data.fullNameQuad.trim() !== fullNameQuad.trim();
    if (!needsReset && !nameChanged) return;

    await setDoc(ref, {
      uid,
      fullNameQuad: fullNameQuad.trim().slice(0, 120),
      epoch,
      correctCount: needsReset ? 0 : Math.max(0, Number(data.correctCount || 0)),
      wrongCount: needsReset ? 0 : Math.max(0, Number(data.wrongCount || 0)),
      totalQuestions: needsReset ? 0 : Math.max(0, Number(data.totalQuestions || 0)),
      attemptsCount: needsReset ? 0 : Math.max(0, Number(data.attemptsCount || 0)),
      statsSnapshot: needsReset ? makeEmptyStatsSnapshot() : (data.statsSnapshot || makeEmptyStatsSnapshot()),
      joinedAt: Number(data.joinedAt || Date.now()),
      updatedAt: serverTimestamp(),
    });
    return;
  }

  await setDoc(ref, {
    uid,
    fullNameQuad: fullNameQuad.trim().slice(0, 120),
    epoch,
    correctCount: 0,
    wrongCount: 0,
    totalQuestions: 0,
    attemptsCount: 0,
    statsSnapshot: makeEmptyStatsSnapshot(),
    joinedAt: Date.now(),
    updatedAt: serverTimestamp(),
  });
}

export async function syncUserStatsToLeaderboard(
  uid: string,
  fullNameQuad: string,
  attempts: QuizAttempt[],
  activeResetEpoch?: number
): Promise<void> {
  if (!uid || !fullNameQuad.trim()) return;
  const epoch = Math.max(INITIAL_LEADERBOARD_EPOCH, activeResetEpoch || getCachedLeaderboardEpoch());
  const built = buildLeaderboardStatsSnapshot(attempts, epoch);

  const ref = doc(db, 'leaderboardUsers', uid);
  let joinedAt = Date.now();
  try {
    const existing = await getDoc(ref);
    if (existing.exists()) {
      const prev = existing.data() as LeaderboardUserEntry;
      joinedAt = Number(prev.joinedAt || joinedAt);
      if (
        Number(prev.epoch || 0) === epoch &&
        prev.fullNameQuad.trim() === fullNameQuad.trim() &&
        prev.correctCount === built.correctCount &&
        prev.wrongCount === built.wrongCount &&
        prev.totalQuestions === built.totalQuestions &&
        prev.attemptsCount === built.attemptsCount
      ) {
        return;
      }
    }
  } catch {
    // Ignore read failure and proceed to write
  }

  await setDoc(ref, {
    uid,
    fullNameQuad: fullNameQuad.trim().slice(0, 120),
    epoch,
    correctCount: built.correctCount,
    wrongCount: built.wrongCount,
    totalQuestions: built.totalQuestions,
    attemptsCount: built.attemptsCount,
    statsSnapshot: built.statsSnapshot,
    joinedAt,
    updatedAt: serverTimestamp(),
  });
}

export async function fetchUserAttemptsAndSyncLeaderboard(
  uid: string,
  fullNameQuad: string,
  extraAttempt?: QuizAttempt
): Promise<void> {
  if (!uid || !fullNameQuad.trim()) return;
  let metaEpoch = getCachedLeaderboardEpoch();
  try {
    const metaSnap = await getDoc(doc(db, 'platform', 'leaderboardMeta'));
    if (metaSnap.exists()) {
      metaEpoch = getEffectiveResetEpoch(metaSnap.data() as LeaderboardMetaDoc);
      setCachedLeaderboardEpoch(metaEpoch);
    }
  } catch {
    // Use cached epoch
  }

  const attemptsSnap = await getDocs(
    query(collection(db, 'users', uid, 'quizAttempts'), where('ownerId', '==', uid))
  );
  const byId = new Map<string, QuizAttempt>();
  attemptsSnap.forEach((d) => {
    const a = d.data() as QuizAttempt;
    if (a?.id) byId.set(a.id, a);
  });
  if (extraAttempt?.id) {
    byId.set(extraAttempt.id, extraAttempt);
  }
  await syncUserStatsToLeaderboard(uid, fullNameQuad, Array.from(byId.values()), metaEpoch);
}

export async function resetLeaderboardEpoch(
  programmerUid: string,
  programmerName: string
): Promise<number> {
  const newEpoch = Date.now();
  await setDoc(doc(db, 'platform', 'leaderboardMeta'), {
    id: 'leaderboardMeta',
    resetEpoch: newEpoch,
    updatedBy: programmerUid,
    updatedByName: programmerName.trim().slice(0, 120) || 'المبرمج',
    updatedAt: serverTimestamp(),
  });
  setCachedLeaderboardEpoch(newEpoch);

  // Immediately reset the programmer's own doc in the new epoch
  await syncUserStatsToLeaderboard(programmerUid, programmerName, [], newEpoch).catch(() => undefined);
  return newEpoch;
}

export function subscribeLeaderboardMeta(onChange: (resetEpoch: number) => void): () => void {
  return onSnapshot(
    doc(db, 'platform', 'leaderboardMeta'),
    (snap) => {
      if (snap.exists()) {
        const eff = getEffectiveResetEpoch(snap.data() as LeaderboardMetaDoc);
        setCachedLeaderboardEpoch(eff);
        onChange(eff);
      } else {
        onChange(getCachedLeaderboardEpoch());
      }
    },
    () => {
      onChange(getCachedLeaderboardEpoch());
    }
  );
}

export function subscribeLeaderboardUsers(
  onChange: (users: LeaderboardUserEntry[]) => void,
  onError?: (err: Error) => void
): () => void {
  return onSnapshot(
    collection(db, 'leaderboardUsers'),
    (snap) => {
      const list: LeaderboardUserEntry[] = [];
      snap.forEach((d) => {
        const row = d.data() as LeaderboardUserEntry;
        if (row?.uid && row?.fullNameQuad) {
          list.push(row);
        }
      });
      onChange(list);
    },
    (err) => {
      onError?.(err);
    }
  );
}

/* ===================== طلبات الصداقة وقائمة الأصدقاء ===================== */

export async function sendFriendRequest(params: {
  fromUid: string;
  fromName: string;
  toUid: string;
  toName: string;
}): Promise<void> {
  const { fromUid, fromName, toUid, toName } = params;
  if (!fromUid || !toUid || fromUid === toUid) return;
  const reqId = makeFriendRequestId(fromUid, toUid);
  await setDoc(doc(db, 'friendRequests', reqId), {
    id: reqId,
    fromUid,
    fromName: fromName.trim().slice(0, 120),
    toUid,
    toName: toName.trim().slice(0, 120),
    status: 'pending',
    createdAtMs: Date.now(),
    updatedAt: serverTimestamp(),
  });
}

export async function cancelOutgoingFriendRequest(fromUid: string, toUid: string): Promise<void> {
  const reqId = makeFriendRequestId(fromUid, toUid);
  await deleteDoc(doc(db, 'friendRequests', reqId));
}

export async function respondToFriendRequest(params: {
  request: FriendRequestDoc;
  accept: boolean;
  myUid: string;
  myName: string;
}): Promise<void> {
  const { request, accept, myUid, myName } = params;
  if (request.toUid !== myUid) return;
  const reqRef = doc(db, 'friendRequests', request.id);
  const nowMs = Date.now();

  await setDoc(reqRef, {
    id: request.id,
    fromUid: request.fromUid,
    fromName: request.fromName,
    toUid: request.toUid,
    toName: request.toName,
    status: accept ? 'accepted' : 'rejected',
    createdAtMs: request.createdAtMs || nowMs,
    updatedAt: serverTimestamp(),
  });

  if (accept) {
    const pairId = makePairId(request.fromUid, request.toUid);
    const sortedUids = [request.fromUid, request.toUid].sort();
    const namesMap: Record<string, string> = {
      [request.fromUid]: request.fromName,
      [request.toUid]: myName.trim() || request.toName,
    };

    await setDoc(doc(db, 'friendships', pairId), {
      id: pairId,
      uids: sortedUids,
      names: namesMap,
      createdBy: myUid,
      createdAtMs: nowMs,
      updatedAt: serverTimestamp(),
    });

    // Ensure direct chat thread exists right away
    const chatRef = doc(db, 'directChats', pairId);
    const chatSnap = await getDoc(chatRef);
    if (!chatSnap.exists()) {
      await setDoc(chatRef, {
        id: pairId,
        participantIds: sortedUids,
        participantNames: namesMap,
        lastMessageText: 'أصبحتما صديقين الآن — ابدأ المحادثة أو شارك اختباراً!',
        lastMessageType: 'init',
        lastSenderId: myUid,
        lastSenderName: myName.trim() || request.toName,
        lastMessageAtMs: nowMs,
        readAtMsByUid: {
          [request.fromUid]: nowMs,
          [request.toUid]: nowMs,
        },
        updatedAt: serverTimestamp(),
      });
    }
  }
}

export async function removeFriendship(myUid: string, friendUid: string): Promise<void> {
  const pairId = makePairId(myUid, friendUid);
  await deleteDoc(doc(db, 'friendships', pairId));
  await Promise.all([
    deleteDoc(doc(db, 'friendRequests', makeFriendRequestId(myUid, friendUid))).catch(() => undefined),
    deleteDoc(doc(db, 'friendRequests', makeFriendRequestId(friendUid, myUid))).catch(() => undefined),
  ]);
}

export function subscribeIncomingFriendRequests(
  myUid: string,
  onChange: (items: FriendRequestDoc[]) => void
): () => void {
  return onSnapshot(
    query(collection(db, 'friendRequests'), where('toUid', '==', myUid)),
    (snap) => {
      const list: FriendRequestDoc[] = [];
      snap.forEach((d) => list.push(d.data() as FriendRequestDoc));
      list.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
      onChange(list);
    },
    (err) => {
      console.error('incoming friendRequests listener error', err);
    }
  );
}

export function subscribeOutgoingFriendRequests(
  myUid: string,
  onChange: (items: FriendRequestDoc[]) => void
): () => void {
  return onSnapshot(
    query(collection(db, 'friendRequests'), where('fromUid', '==', myUid)),
    (snap) => {
      const list: FriendRequestDoc[] = [];
      snap.forEach((d) => list.push(d.data() as FriendRequestDoc));
      list.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
      onChange(list);
    },
    (err) => {
      console.error('outgoing friendRequests listener error', err);
    }
  );
}

export function subscribeFriendships(
  myUid: string,
  onChange: (items: FriendshipDoc[]) => void
): () => void {
  return onSnapshot(
    query(collection(db, 'friendships'), where('uids', 'array-contains', myUid)),
    (snap) => {
      const list: FriendshipDoc[] = [];
      snap.forEach((d) => list.push(d.data() as FriendshipDoc));
      list.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
      onChange(list);
    },
    (err) => {
      console.error('friendships listener error', err);
    }
  );
}

/* ===================== المحادثات ومشاركة الاختبارات بين الأصدقاء ===================== */

export async function ensureDirectChatThread(params: {
  myUid: string;
  myName: string;
  friendUid: string;
  friendName: string;
}): Promise<string> {
  const { myUid, myName, friendUid, friendName } = params;
  if (!myUid || !friendUid || myUid === friendUid) {
    throw new Error('معرّف الطرف الآخر غير صالح للمحادثة.');
  }
  const chatId = makePairId(myUid, friendUid);
  const chatRef = doc(db, 'directChats', chatId);
  let exists = false;
  try {
    const snap = await getDoc(chatRef);
    exists = snap.exists();
  } catch {
    exists = false;
  }
  if (!exists) {
    const sorted = [myUid, friendUid].sort();
    const nowMs = Math.floor(Date.now());
    const safeMyName = (myName.trim() || 'مستخدم').slice(0, 120);
    const safeFriendName = (friendName.trim() || 'صديق').slice(0, 120);
    await setDoc(chatRef, {
      id: chatId,
      participantIds: sorted,
      participantNames: {
        [myUid]: safeMyName,
        [friendUid]: safeFriendName,
      },
      lastMessageText: '',
      lastMessageType: 'init',
      lastSenderId: myUid,
      lastSenderName: safeMyName,
      lastMessageAtMs: 0,
      readAtMsByUid: {
        [myUid]: nowMs,
        [friendUid]: nowMs,
      },
      updatedAt: serverTimestamp(),
    });
  }
  return chatId;
}

export async function sendDirectTextMessage(params: {
  myUid: string;
  myName: string;
  friendUid: string;
  friendName: string;
  text: string;
}): Promise<void> {
  const cleanText = params.text.trim();
  if (!cleanText) return;
  const chatId = await ensureDirectChatThread(params);
  const nowMs = Math.floor(Date.now());
  const msgId = `msg_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const sorted = [params.myUid, params.friendUid].sort();
  const safeMyName = (params.myName.trim() || 'مستخدم').slice(0, 120);
  const safeFriendName = (params.friendName.trim() || 'صديق').slice(0, 120);

  const msgRef = doc(db, 'directChats', chatId, 'messages', msgId);
  await setDoc(msgRef, {
    id: msgId,
    chatId,
    senderId: params.myUid,
    senderName: safeMyName,
    recipientId: params.friendUid,
    participantIds: sorted,
    type: 'text',
    text: cleanText.slice(0, 4000),
    createdAtMs: nowMs,
    createdAt: serverTimestamp(),
  });

  const chatRef = doc(db, 'directChats', chatId);
  let prevReadMap: Record<string, number> = {};
  let participantIds = sorted;
  try {
    const prevSnap = await getDoc(chatRef);
    if (prevSnap.exists()) {
      const prevData = prevSnap.data() as DirectChatDoc;
      prevReadMap = prevData.readAtMsByUid || {};
      if (Array.isArray(prevData.participantIds) && prevData.participantIds.length === 2) {
        participantIds = prevData.participantIds;
      }
    }
  } catch {
    // Use defaults
  }

  await setDoc(chatRef, {
    id: chatId,
    participantIds,
    participantNames: {
      [params.myUid]: safeMyName,
      [params.friendUid]: safeFriendName,
    },
    lastMessageText: cleanText.slice(0, 220),
    lastMessageType: 'text',
    lastSenderId: params.myUid,
    lastSenderName: safeMyName,
    lastMessageAtMs: nowMs,
    readAtMsByUid: {
      ...prevReadMap,
      [params.myUid]: nowMs,
    },
    updatedAt: serverTimestamp(),
  });
}

function estimatePayloadBytes(obj: unknown): number {
  try {
    return new Blob([JSON.stringify(obj)]).size;
  } catch {
    return JSON.stringify(obj).length * 2;
  }
}

export function splitQuizForFriendShare(
  title: string,
  rawQuestions: QuizQuestion[]
): Array<{ title: string; questions: QuizQuestion[] }> {
  const cleaned = cleanQuestions(rawQuestions).slice(0, LIMITS.maxQuestions);
  if (cleaned.length === 0) return [];
  const baseTitle = (title.trim() || 'اختبار مشترك').slice(0, 120);

  const chunks: QuizQuestion[][] = [];
  let current: QuizQuestion[] = [];

  for (const q of cleaned) {
    const candidate = [...current, q];
    const encoded = prepareQuestionsForFirestore(candidate);
    if (
      current.length > 0 &&
      estimatePayloadBytes({ title: baseTitle, questions: encoded }) > 760_000
    ) {
      chunks.push(current);
      current = [q];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);

  if (chunks.length === 1) {
    return [{ title: baseTitle, questions: chunks[0] }];
  }
  return chunks.map((qs, idx) => ({
    title: `${baseTitle} (جزء ${idx + 1}/${chunks.length})`.slice(0, 140),
    questions: qs,
  }));
}

export async function sendQuizToFriend(params: {
  myUid: string;
  myName: string;
  friendUid: string;
  friendName: string;
  quiz: MyQuiz;
}): Promise<number> {
  const { myUid, myName, friendUid, friendName, quiz } = params;
  const parts = splitQuizForFriendShare(quiz.title, quiz.questions);
  if (parts.length === 0) {
    throw new Error('هذا الاختبار لا يحتوي على أسئلة صالحة للإرسال.');
  }

  const chatId = await ensureDirectChatThread({ myUid, myName, friendUid, friendName });
  const chatRef = doc(db, 'directChats', chatId);
  const sorted = [myUid, friendUid].sort();
  const safeMyName = (myName.trim() || 'صديق').slice(0, 120);
  const safeFriendName = (friendName.trim() || 'صديق').slice(0, 120);
  let prevReadMap: Record<string, number> = {};
  let participantIds = sorted;
  try {
    const prevSnap = await getDoc(chatRef);
    if (prevSnap.exists()) {
      const prevData = prevSnap.data() as DirectChatDoc;
      prevReadMap = prevData.readAtMsByUid || {};
      if (Array.isArray(prevData.participantIds) && prevData.participantIds.length === 2) {
        participantIds = prevData.participantIds;
      }
    }
  } catch {
    // Use defaults
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const nowMs = Math.floor(Date.now()) + i;
    const sharedId = `shq_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const encodedQuestions = prepareQuestionsForFirestore(part.questions);

    await setDoc(doc(db, 'sharedFriendQuizzes', sharedId), {
      id: sharedId,
      chatId,
      senderId: myUid,
      senderName: safeMyName,
      recipientId: friendUid,
      title: part.title,
      questions: encodedQuestions,
      questionCount: part.questions.length,
      createdAtMs: nowMs,
      createdAt: serverTimestamp(),
    });

    const msgId = `msg_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    await setDoc(doc(db, 'directChats', chatId, 'messages', msgId), {
      id: msgId,
      chatId,
      senderId: myUid,
      senderName: safeMyName,
      recipientId: friendUid,
      participantIds,
      type: 'quiz_share',
      text: `أرسل لك اختباراً: ${part.title} (${part.questions.length} سؤال)`,
      quizShare: {
        sharedQuizDocId: sharedId,
        quizTitle: part.title,
        questionCount: part.questions.length,
        senderName: safeMyName,
      },
      createdAtMs: nowMs,
      createdAt: serverTimestamp(),
    });
  }

  const lastPart = parts[parts.length - 1];
  const lastNowMs = Math.floor(Date.now()) + parts.length;
  await setDoc(chatRef, {
    id: chatId,
    participantIds,
    participantNames: {
      [myUid]: safeMyName,
      [friendUid]: safeFriendName,
    },
    lastMessageText: `أرسل اختباراً: ${lastPart.title}`.slice(0, 220),
    lastMessageType: 'quiz_share',
    lastSenderId: myUid,
    lastSenderName: safeMyName,
    lastMessageAtMs: lastNowMs,
    readAtMsByUid: {
      ...prevReadMap,
      [myUid]: lastNowMs,
    },
    updatedAt: serverTimestamp(),
  });

  return parts.length;
}

export function getAcceptedSharedQuizIds(myUid: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(`${ACCEPTED_SHARED_PREFIX}${myUid}`);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function markSharedQuizAccepted(
  myUid: string,
  sharedQuizDocId: string,
  createdQuizId: string
): void {
  try {
    const prev = getAcceptedSharedQuizIds(myUid);
    prev[sharedQuizDocId] = createdQuizId;
    localStorage.setItem(`${ACCEPTED_SHARED_PREFIX}${myUid}`, JSON.stringify(prev));
  } catch {
    // Ignore storage issues
  }
}

export async function acceptSharedFriendQuizToMyQuizzes(params: {
  myUid: string;
  sharedQuizDocId: string;
  fallbackTitle?: string;
}): Promise<{ quizIds: string[]; title: string; questionCount: number }> {
  const { myUid, sharedQuizDocId, fallbackTitle } = params;
  const snap = await getDoc(doc(db, 'sharedFriendQuizzes', sharedQuizDocId));
  if (!snap.exists()) {
    throw new Error('تعذر العثور على ملف الاختبار المرسل.');
  }
  const raw = snap.data() as SharedFriendQuizDoc;
  const decoded = decodeMyQuizFromFirestore({
    id: raw.id,
    ownerId: myUid,
    title: raw.title || fallbackTitle || 'اختبار مرسل من صديق',
    questions: raw.questions || [],
    questionCount: raw.questionCount || raw.questions?.length || 0,
  });

  const createdChunks = await createMyQuizzesAutoSplit(
    myUid,
    decoded.title,
    decoded.questions,
    { quizKind: 'main' }
  );

  const createdIds = createdChunks.map((c) => c.id);
  if (createdIds[0]) {
    markSharedQuizAccepted(myUid, sharedQuizDocId, createdIds[0]);
  }
  return {
    quizIds: createdIds,
    title: decoded.title,
    questionCount: decoded.questions.length,
  };
}

export async function markDirectChatRead(chat: DirectChatDoc, myUid: string): Promise<void> {
  if (!chat?.id || !myUid) return;
  const myRead = Number(chat.readAtMsByUid?.[myUid] || 0);
  const lastMsgAt = Math.floor(Number(chat.lastMessageAtMs || 0));
  if (lastMsgAt === 0 || myRead >= lastMsgAt) return;

  await setDoc(doc(db, 'directChats', chat.id), {
    id: chat.id,
    participantIds: chat.participantIds,
    participantNames: chat.participantNames || {},
    lastMessageText: String(chat.lastMessageText || '').slice(0, 500),
    lastMessageType: chat.lastMessageType || 'text',
    lastSenderId: String(chat.lastSenderId || '').slice(0, 128),
    lastSenderName: String(chat.lastSenderName || '').slice(0, 120),
    lastMessageAtMs: lastMsgAt,
    readAtMsByUid: {
      ...(chat.readAtMsByUid || {}),
      [myUid]: Math.floor(Date.now()),
    },
    updatedAt: serverTimestamp(),
  });
}

export function subscribeDirectChats(
  myUid: string,
  onChange: (chats: DirectChatDoc[]) => void
): () => void {
  return onSnapshot(
    query(collection(db, 'directChats'), where('participantIds', 'array-contains', myUid)),
    (snap) => {
      const list: DirectChatDoc[] = [];
      snap.forEach((d) => list.push(d.data() as DirectChatDoc));
      list.sort((a, b) => (b.lastMessageAtMs || 0) - (a.lastMessageAtMs || 0));
      onChange(list);
    },
    (err) => {
      console.error('directChats listener error', err);
    }
  );
}

export function subscribeChatMessages(
  chatId: string,
  myUid: string,
  onChange: (msgs: DirectMessageDoc[]) => void,
  onError?: (err: unknown) => void
): () => void {
  return onSnapshot(
    query(
      collection(db, 'directChats', chatId, 'messages'),
      where('participantIds', 'array-contains', myUid)
    ),
    (snap) => {
      const list: DirectMessageDoc[] = [];
      snap.forEach((d) => list.push(d.data() as DirectMessageDoc));
      list.sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
      onChange(list);
    },
    (err) => {
      console.error('chat messages listener error', err);
      onError?.(err);
    }
  );
}
