import { useEffect, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { db, getTimestampMillis, handleFirestoreError, OperationType } from './firebase';
import {
  loadSessionSnapshot,
  saveMyQuizzesSnapshot,
  type StoredMyQuizzesSnapshot,
} from './localDraftStore';
import { cleanQuestions, LIMITS } from './myQuizzes';
import type { MyQuiz, SharedQuiz } from './types';

export function makeSharedQuizDocId(uid: string, quizId: string): string {
  const safeUid = uid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  const safeQuiz = quizId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 72);
  return `${safeUid}_${safeQuiz}`.slice(0, 128);
}

export interface RoomQuizEntry {
  /** معرف فريد موحد للاستخدام في القوائم والاختيارات */
  poolId: string;
  quiz: MyQuiz;
  authorId: string;
  authorName: string;
  authorRole: 'supervisor' | 'student';
  isMine: boolean;
  sharedDocId?: string;
}

export function useMyQuizzes(uid: string) {
  const [myQuizzes, setMyQuizzes] = useState<MyQuiz[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) {
      setMyQuizzes([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    void loadSessionSnapshot<StoredMyQuizzesSnapshot>('my_quizzes').then((snap) => {
      if (cancelled || !snap || snap.ownerId !== uid) return;
      if (snap.quizzes.length > 0) {
        setMyQuizzes(snap.quizzes);
      }
    });

    const path = `users/${uid}/myQuizzes`;
    const q = query(collection(db, 'users', uid, 'myQuizzes'), where('ownerId', '==', uid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: MyQuiz[] = [];
        snap.forEach((d) => list.push(d.data() as MyQuiz));
        list.sort(
          (a, b) =>
            getTimestampMillis(b.updatedAt || b.createdAt) -
            getTimestampMillis(a.updatedAt || a.createdAt)
        );
        setMyQuizzes(list);
        setLoading(false);
        void saveMyQuizzesSnapshot(uid, list);
      },
      (err) => {
        setLoading(false);
        handleFirestoreError(err, OperationType.LIST, path);
      }
    );

    return () => {
      cancelled = true;
      unsub();
    };
  }, [uid]);

  return { myQuizzes, loading };
}

export function useRoomSharedQuizzes(roomId: string) {
  const [sharedQuizzes, setSharedQuizzes] = useState<SharedQuiz[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!roomId) {
      setSharedQuizzes([]);
      setLoading(false);
      return;
    }

    const path = `rooms/${roomId}/sharedQuizzes`;
    const q = query(
      collection(db, 'rooms', roomId, 'sharedQuizzes'),
      where('roomId', '==', roomId)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: SharedQuiz[] = [];
        snap.forEach((d) => list.push(d.data() as SharedQuiz));
        list.sort((a, b) => getTimestampMillis(b.updatedAt) - getTimestampMillis(a.updatedAt));
        setSharedQuizzes(list);
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        handleFirestoreError(err, OperationType.LIST, path);
      }
    );

    return () => unsub();
  }, [roomId]);

  return { sharedQuizzes, loading };
}

export async function publishQuizToRoom(params: {
  roomId: string;
  authorId: string;
  authorName: string;
  authorRole: 'supervisor' | 'student';
  quiz: MyQuiz;
}): Promise<string> {
  const { roomId, authorId, authorName, authorRole, quiz } = params;
  const cleaned = cleanQuestions(quiz.questions || []);
  if (cleaned.length === 0) return '';
  const sharedDocId = makeSharedQuizDocId(authorId, quiz.id);
  const path = `rooms/${roomId}/sharedQuizzes/${sharedDocId}`;

  try {
    await setDoc(doc(db, 'rooms', roomId, 'sharedQuizzes', sharedDocId), {
      id: sharedDocId,
      roomId,
      authorId,
      authorName: authorName.trim().slice(0, 120) || 'مشارك',
      authorRole,
      title: quiz.title.trim().slice(0, LIMITS.title) || 'اختبار',
      questions: cleaned,
      questionCount: cleaned.length,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
  return sharedDocId;
}

export async function syncUserQuizzesToRoom(params: {
  roomId: string;
  authorId: string;
  authorName: string;
  authorRole: 'supervisor' | 'student';
  myQuizzes: MyQuiz[];
  existingShared: SharedQuiz[];
}): Promise<number> {
  const { roomId, authorId, authorName, authorRole, myQuizzes, existingShared } = params;
  let synced = 0;

  for (const quiz of myQuizzes) {
    const cleaned = cleanQuestions(quiz.questions || []);
    if (cleaned.length === 0) continue;

    const sharedDocId = makeSharedQuizDocId(authorId, quiz.id);
    const existing = existingShared.find((s) => s.id === sharedDocId);

    if (
      existing &&
      existing.title === quiz.title.trim().slice(0, LIMITS.title) &&
      existing.questionCount === cleaned.length &&
      JSON.stringify(existing.questions) === JSON.stringify(cleaned)
    ) {
      continue;
    }

    await publishQuizToRoom({
      roomId,
      authorId,
      authorName,
      authorRole,
      quiz,
    });
    synced++;
  }

  return synced;
}

export async function unpublishQuizFromRoom(roomId: string, sharedDocId: string): Promise<void> {
  const path = `rooms/${roomId}/sharedQuizzes/${sharedDocId}`;
  try {
    await deleteDoc(doc(db, 'rooms', roomId, 'sharedQuizzes', sharedDocId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

/**
 * يدمج اختبارات المستخدم نفسه مع الاختبارات المشاركة في الغرفة من المشرف والطلاب
 * بدون تكرار، مع تحديد صاحب كل اختبار ودوره (مشرف / طالب).
 */
export function buildRoomQuizPool(params: {
  myQuizzes: MyQuiz[];
  sharedQuizzes: SharedQuiz[];
  myUid: string;
  myName: string;
  isSupervisor: boolean;
}): RoomQuizEntry[] {
  const { myQuizzes, sharedQuizzes, myUid, myName, isSupervisor } = params;
  const entries: RoomQuizEntry[] = [];
  const seenIds = new Set<string>();

  for (const q of myQuizzes) {
    if (!q.questions || q.questions.length === 0) continue;
    const sharedDocId = makeSharedQuizDocId(myUid, q.id);
    seenIds.add(sharedDocId);
    entries.push({
      poolId: sharedDocId,
      quiz: {
        ...q,
        id: sharedDocId,
      },
      authorId: myUid,
      authorName: myName,
      authorRole: isSupervisor ? 'supervisor' : 'student',
      isMine: true,
      sharedDocId: sharedQuizzes.some((s) => s.id === sharedDocId) ? sharedDocId : undefined,
    });
  }

  for (const sq of sharedQuizzes) {
    if (seenIds.has(sq.id)) continue;
    if (!sq.questions || sq.questions.length === 0) continue;
    seenIds.add(sq.id);
    entries.push({
      poolId: sq.id,
      quiz: {
        id: sq.id,
        ownerId: sq.authorId,
        title: sq.title,
        questions: sq.questions,
        questionCount: sq.questionCount,
        createdAt: sq.updatedAt,
        updatedAt: sq.updatedAt,
      },
      authorId: sq.authorId,
      authorName: sq.authorName,
      authorRole: sq.authorRole,
      isMine: sq.authorId === myUid,
      sharedDocId: sq.id,
    });
  }

  return entries;
}
