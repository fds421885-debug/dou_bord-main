import {
  collection,
  deleteDoc as rawDeleteDoc,
  doc,
  getDoc as rawGetDoc,
  getDocFromServer as rawGetDocFromServer,
  getDocs as rawGetDocs,
  getFirestore,
  onSnapshot as rawOnSnapshot,
  query,
  runTransaction as rawRunTransaction,
  serverTimestamp,
  setDoc as rawSetDoc,
  updateDoc as rawUpdateDoc,
  where,
  writeBatch as rawWriteBatch,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type FirestoreError,
  type Query,
  type QuerySnapshot,
  type SetOptions,
  type Transaction,
  type Unsubscribe,
  type WriteBatch,
} from 'firebase/firestore';
import { isQuotaError } from './firebase';
import { recordFirestoreOperations, reportFirestoreQuotaExhausted } from './quotaTracker';

export {
  collection,
  doc,
  getFirestore,
  query,
  serverTimestamp,
  where,
  type DocumentReference,
  type Firestore,
};

function resolveProjectId(target: unknown): string | undefined {
  try {
    const obj = target as { firestore?: Firestore; app?: { options?: { projectId?: string } } };
    if (obj?.firestore?.app?.options?.projectId) {
      return obj.firestore.app.options.projectId;
    }
    if (obj?.app?.options?.projectId) {
      return obj.app.options.projectId;
    }
  } catch {
    // Ignore
  }
  return undefined;
}

export async function getDoc<AppModelType = DocumentData, DbModelType extends DocumentData = DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>
): Promise<DocumentSnapshot<AppModelType, DbModelType>> {
  const pid = resolveProjectId(reference);
  try {
    const snap = await rawGetDoc(reference);
    recordFirestoreOperations(pid, { reads: 1 });
    return snap;
  } catch (err) {
    if (isQuotaError(err)) reportFirestoreQuotaExhausted(pid);
    throw err;
  }
}

export async function getDocFromServer<
  AppModelType = DocumentData,
  DbModelType extends DocumentData = DocumentData,
>(
  reference: DocumentReference<AppModelType, DbModelType>
): Promise<DocumentSnapshot<AppModelType, DbModelType>> {
  const pid = resolveProjectId(reference);
  try {
    const snap = await rawGetDocFromServer(reference);
    recordFirestoreOperations(pid, { reads: 1 });
    return snap;
  } catch (err) {
    if (isQuotaError(err)) reportFirestoreQuotaExhausted(pid);
    throw err;
  }
}

export async function getDocs<AppModelType = DocumentData, DbModelType extends DocumentData = DocumentData>(
  q: Query<AppModelType, DbModelType>
): Promise<QuerySnapshot<AppModelType, DbModelType>> {
  const pid = resolveProjectId(q);
  try {
    const snap = await rawGetDocs(q);
    recordFirestoreOperations(pid, { reads: Math.max(1, snap.size) });
    return snap;
  } catch (err) {
    if (isQuotaError(err)) reportFirestoreQuotaExhausted(pid);
    throw err;
  }
}

export async function setDoc<AppModelType = DocumentData, DbModelType extends DocumentData = DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>,
  data: AppModelType | Partial<AppModelType>,
  options?: SetOptions
): Promise<void> {
  const pid = resolveProjectId(reference);
  try {
    if (options) {
      await rawSetDoc(reference, data as Partial<AppModelType>, options);
    } else {
      await rawSetDoc(reference, data as AppModelType);
    }
    recordFirestoreOperations(pid, { writes: 1 });
  } catch (err) {
    if (isQuotaError(err)) reportFirestoreQuotaExhausted(pid);
    throw err;
  }
}

export async function updateDoc<AppModelType = DocumentData, DbModelType extends DocumentData = DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>,
  data: Record<string, unknown>
): Promise<void> {
  const pid = resolveProjectId(reference);
  try {
    await rawUpdateDoc(reference as DocumentReference<DocumentData, DocumentData>, data);
    recordFirestoreOperations(pid, { writes: 1 });
  } catch (err) {
    if (isQuotaError(err)) reportFirestoreQuotaExhausted(pid);
    throw err;
  }
}

export async function deleteDoc<AppModelType = DocumentData, DbModelType extends DocumentData = DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>
): Promise<void> {
  const pid = resolveProjectId(reference);
  try {
    await rawDeleteDoc(reference);
    recordFirestoreOperations(pid, { deletes: 1 });
  } catch (err) {
    if (isQuotaError(err)) reportFirestoreQuotaExhausted(pid);
    throw err;
  }
}

export function writeBatch(firestore: Firestore): WriteBatch {
  const pid = resolveProjectId(firestore);
  const inner = rawWriteBatch(firestore);
  let queuedWrites = 0;
  let queuedDeletes = 0;

  const tracked: WriteBatch = {
    set(docRef: DocumentReference<unknown, DocumentData>, data: unknown, options?: SetOptions) {
      queuedWrites++;
      if (options) {
        inner.set(docRef, data, options);
      } else {
        inner.set(docRef, data);
      }
      return tracked;
    },
    update(docRef: DocumentReference<unknown, DocumentData>, data: Record<string, unknown>) {
      queuedWrites++;
      inner.update(docRef, data);
      return tracked;
    },
    delete(docRef: DocumentReference<unknown, DocumentData>) {
      queuedDeletes++;
      inner.delete(docRef);
      return tracked;
    },
    async commit() {
      try {
        await inner.commit();
        recordFirestoreOperations(pid, {
          writes: queuedWrites,
          deletes: queuedDeletes,
        });
      } catch (err) {
        if (isQuotaError(err)) reportFirestoreQuotaExhausted(pid);
        throw err;
      }
    },
  } as WriteBatch;

  return tracked;
}

export async function runTransaction<T>(
  firestore: Firestore,
  updateFunction: (transaction: Transaction) => Promise<T>
): Promise<T> {
  const pid = resolveProjectId(firestore);
  try {
    return await rawRunTransaction(firestore, async (tx) => {
      let reads = 0;
      let writes = 0;
      let deletes = 0;
      const proxiedTx: Transaction = {
        get: async (ref) => {
          reads++;
          return tx.get(ref);
        },
        set: (ref, data, options) => {
          writes++;
          if (options) tx.set(ref, data, options);
          else tx.set(ref, data);
          return proxiedTx;
        },
        update: (ref, data) => {
          writes++;
          tx.update(ref, data as Record<string, unknown>);
          return proxiedTx;
        },
        delete: (ref) => {
          deletes++;
          tx.delete(ref);
          return proxiedTx;
        },
      } as Transaction;

      const out = await updateFunction(proxiedTx);
      recordFirestoreOperations(pid, { reads, writes, deletes });
      return out;
    });
  } catch (err) {
    if (isQuotaError(err)) reportFirestoreQuotaExhausted(pid);
    throw err;
  }
}

export function onSnapshot<AppModelType = DocumentData, DbModelType extends DocumentData = DocumentData>(
  reference: DocumentReference<AppModelType, DbModelType>,
  onNext: (snapshot: DocumentSnapshot<AppModelType, DbModelType>) => void,
  onError?: (error: FirestoreError) => void
): Unsubscribe;
export function onSnapshot<AppModelType = DocumentData, DbModelType extends DocumentData = DocumentData>(
  q: Query<AppModelType, DbModelType>,
  onNext: (snapshot: QuerySnapshot<AppModelType, DbModelType>) => void,
  onError?: (error: FirestoreError) => void
): Unsubscribe;
export function onSnapshot(
  target: DocumentReference<DocumentData, DocumentData> | Query<DocumentData, DocumentData>,
  onNext: (snap: DocumentSnapshot<DocumentData, DocumentData> | QuerySnapshot<DocumentData, DocumentData>) => void,
  onError?: (error: FirestoreError) => void
): Unsubscribe {
  const pid = resolveProjectId(target);
  let isInitialSnapshot = true;

  const wrappedNext = (
    snap: DocumentSnapshot<DocumentData, DocumentData> | QuerySnapshot<DocumentData, DocumentData>
  ) => {
    if (snap && 'docs' in snap && typeof snap.docChanges === 'function') {
      const changesCount = snap.docChanges().length;
      if (isInitialSnapshot) {
        recordFirestoreOperations(pid, { reads: Math.max(1, snap.size) });
        isInitialSnapshot = false;
      } else if (changesCount > 0) {
        recordFirestoreOperations(pid, { reads: changesCount });
      }
    } else {
      recordFirestoreOperations(pid, { reads: 1 });
      isInitialSnapshot = false;
    }
    onNext(snap);
  };

  const wrappedError = (err: FirestoreError) => {
    if (isQuotaError(err)) reportFirestoreQuotaExhausted(pid);
    onError?.(err);
  };

  if (target.type === 'document') {
    return rawOnSnapshot(
      target as DocumentReference<DocumentData, DocumentData>,
      wrappedNext as (snap: DocumentSnapshot<DocumentData, DocumentData>) => void,
      wrappedError
    );
  }
  return rawOnSnapshot(
    target as Query<DocumentData, DocumentData>,
    wrappedNext as (snap: QuerySnapshot<DocumentData, DocumentData>) => void,
    wrappedError
  );
}
