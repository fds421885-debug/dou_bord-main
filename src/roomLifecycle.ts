import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
  type DocumentReference,
} from './firestoreTracked';
import { db, handleFirestoreError, OperationType } from './firebase';
import type { Competition, Room } from './types';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function commitDeleteRefs(refs: DocumentReference[]): Promise<void> {
  const CHUNK_SIZE = 400;
  for (let i = 0; i < refs.length; i += CHUNK_SIZE) {
    const batch = writeBatch(db);
    for (const ref of refs.slice(i, i + CHUNK_SIZE)) {
      batch.delete(ref);
    }
    await batch.commit();
  }
}

export function isPermissionOrMissingError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('permission-denied') ||
    msg.includes('permission_denied') ||
    msg.includes('insufficient permissions') ||
    msg.includes('not-found') ||
    msg.includes('no document to update')
  );
}

/**
 * Safely checks whether a room listener error happened simply because the room
 * was closed/deleted or the participant was removed. Avoids crashing the UI
 * with ErrorBoundary while still throwing genuine unexpected errors.
 */
export async function handleRoomListenerError(
  roomId: string,
  err: unknown,
  op: OperationType,
  path: string
): Promise<void> {
  if (isPermissionOrMissingError(err)) {
    try {
      const snap = await getDoc(doc(db, 'rooms', roomId));
      if (!snap.exists()) {
        return;
      }
      const r = snap.data() as Partial<Room>;
      if (r.status === 'finished') {
        return;
      }
    } catch {
      // If even reading rooms/{roomId} is denied/unavailable during teardown, swallow silently
      return;
    }
  }
  handleFirestoreError(err, op, path);
}

/**
 * Closes a room properly and completely:
 * 1. Marks active competitions + room status='finished' so all writes freeze
 *    and connected clients leave child board/slide listeners cleanly.
 * 2. Deletes all room subcollections (questions/boards, slides/layers,
 *    competitions/questions/boards, explainLayers, sharedBoard, sharedQuizzes,
 *    and all participants) BEFORE removing the parent room document so
 *    supervisorId checks in Firestore rules succeed.
 * 3. Deletes `rooms/{roomId}` itself so the room is permanently closed in the
 *    database and every connected participant/supervisor is immediately exited.
 */
export async function closeRoomInDatabase(roomId: string): Promise<void> {
  const cleanId = roomId.trim().toUpperCase();
  if (!cleanId) return;

  const roomRef = doc(db, 'rooms', cleanId);
  const roomSnap = await getDoc(roomRef);
  if (!roomSnap.exists()) {
    return;
  }

  const roomData = roomSnap.data() as Room;

  // Step 1: Finish any active competitions while room.status is still 'active'
  const compRefsToDelete: DocumentReference[] = [];
  const compQuestionRefsToDelete: DocumentReference[] = [];
  const compBoardRefsToDelete: DocumentReference[] = [];

  try {
    const compsSnap = await getDocs(
      query(collection(db, 'rooms', cleanId, 'competitions'), where('roomId', '==', cleanId))
    );
    for (const compDoc of compsSnap.docs) {
      compRefsToDelete.push(compDoc.ref);
      const compData = compDoc.data() as Competition;
      if (compData.status === 'active' && roomData.status === 'active') {
        await updateDoc(compDoc.ref, {
          status: 'finished',
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      }

      const cqSnap = await getDocs(
        query(
          collection(db, 'rooms', cleanId, 'competitions', compDoc.id, 'questions'),
          where('roomId', '==', cleanId),
          where('competitionId', '==', compDoc.id)
        )
      );
      for (const cqDoc of cqSnap.docs) {
        compQuestionRefsToDelete.push(cqDoc.ref);
        const cbSnap = await getDocs(
          query(
            collection(
              db,
              'rooms',
              cleanId,
              'competitions',
              compDoc.id,
              'questions',
              cqDoc.id,
              'boards'
            ),
            where('roomId', '==', cleanId),
            where('questionId', '==', cqDoc.id)
          )
        );
        cbSnap.forEach((bDoc) => compBoardRefsToDelete.push(bDoc.ref));
      }
    }
  } catch {
    // Non-fatal; continue cleaning remaining collections
  }

  // Lock the room immediately if not already finished
  if (roomData.status !== 'finished') {
    try {
      await updateDoc(roomRef, {
        status: 'finished',
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${cleanId}`);
    }
    // Brief pause so connected clients unmount sub-listeners (e.g. sharedBoard/live) cleanly
    await delay(220);
  }

  // Step 2: Gather and delete all remaining subcollections BEFORE deleting the parent room doc
  const leafDeleteRefs: DocumentReference[] = [...compBoardRefsToDelete];
  const midDeleteRefs: DocumentReference[] = [...compQuestionRefsToDelete, ...compRefsToDelete];

  try {
    const qSnap = await getDocs(
      query(collection(db, 'rooms', cleanId, 'questions'), where('roomId', '==', cleanId))
    );
    for (const qDoc of qSnap.docs) {
      midDeleteRefs.push(qDoc.ref);
      const bSnap = await getDocs(
        query(
          collection(db, 'rooms', cleanId, 'questions', qDoc.id, 'boards'),
          where('roomId', '==', cleanId),
          where('questionId', '==', qDoc.id)
        )
      );
      bSnap.forEach((bDoc) => leafDeleteRefs.push(bDoc.ref));
    }
  } catch {
    // Continue cleanup
  }

  try {
    const sSnap = await getDocs(
      query(collection(db, 'rooms', cleanId, 'slides'), where('roomId', '==', cleanId))
    );
    for (const sDoc of sSnap.docs) {
      midDeleteRefs.push(sDoc.ref);
      const lSnap = await getDocs(
        query(
          collection(db, 'rooms', cleanId, 'slides', sDoc.id, 'layers'),
          where('roomId', '==', cleanId),
          where('slideId', '==', sDoc.id)
        )
      );
      lSnap.forEach((lDoc) => leafDeleteRefs.push(lDoc.ref));
    }
  } catch {
    // Continue cleanup
  }

  try {
    const elSnap = await getDocs(
      query(collection(db, 'rooms', cleanId, 'explainLayers'), where('roomId', '==', cleanId))
    );
    elSnap.forEach((d) => leafDeleteRefs.push(d.ref));
  } catch {
    // Continue cleanup
  }

  try {
    const sbSnap = await getDoc(doc(db, 'rooms', cleanId, 'sharedBoard', 'live'));
    if (sbSnap.exists()) {
      leafDeleteRefs.push(sbSnap.ref);
    }
  } catch {
    // Continue cleanup
  }

  try {
    const sqSnap = await getDocs(
      query(collection(db, 'rooms', cleanId, 'sharedQuizzes'), where('roomId', '==', cleanId))
    );
    sqSnap.forEach((d) => leafDeleteRefs.push(d.ref));
  } catch {
    // Continue cleanup
  }

  try {
    const pSnap = await getDocs(
      query(collection(db, 'rooms', cleanId, 'participants'), where('roomId', '==', cleanId))
    );
    pSnap.forEach((d) => leafDeleteRefs.push(d.ref));
  } catch {
    // Continue cleanup
  }

  await commitDeleteRefs(leafDeleteRefs);
  await commitDeleteRefs(midDeleteRefs);

  // Step 3: Delete the room document itself so it is permanently closed in the database
  try {
    await deleteDoc(roomRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `rooms/${cleanId}`);
  }
}
