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

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== 'object' || val === null) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function sanitizeFirestoreValue(val: unknown): unknown {
  if (val === undefined || typeof val === 'function' || typeof val === 'symbol') {
    return undefined;
  }
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : 0;
  }
  if (Array.isArray(val)) {
    const out: unknown[] = [];
    for (const item of val) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      if (Array.isArray(item)) {
        // Firestore rejects Array<Array<...>> directly; wrap cleanly into { cells }
        out.push({ cells: sanitizeFirestoreValue(item) });
      } else {
        const cleanItem = sanitizeFirestoreValue(item);
        if (cleanItem !== undefined) out.push(cleanItem);
      }
    }
    return out;
  }
  if (isPlainObject(val)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      const cleanVal = sanitizeFirestoreValue(v);
      if (cleanVal !== undefined) out[k] = cleanVal;
    }
    return out;
  }
  // Preserve FieldValue sentinels (serverTimestamp, increment, deleteField), Timestamp, Date, GeoPoint, Bytes
  return val;
}

function sanitizeFirestoreWritePayload<T>(data: T): T {
  return sanitizeFirestoreValue(data) as T;
}

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
  const safeData = sanitizeFirestoreWritePayload(data);
  try {
    if (options) {
      await rawSetDoc(reference, safeData as Partial<AppModelType>, options);
    } else {
      await rawSetDoc(reference, safeData as AppModelType);
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
  const safeData = sanitizeFirestoreWritePayload(data);
  try {
    await rawUpdateDoc(reference as DocumentReference<DocumentData, DocumentData>, safeData);
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

  const tracked = {
    set(
      docRef: DocumentReference<unknown, DocumentData>,
      data: unknown,
      options?: SetOptions
    ) {
      queuedWrites++;
      const safeData = sanitizeFirestoreWritePayload(data);
      if (options) {
        (inner.set as (r: unknown, d: unknown, o: SetOptions) => unknown)(docRef, safeData, options);
      } else {
        (inner.set as (r: unknown, d: unknown) => unknown)(docRef, safeData);
      }
      return tracked;
    },
    update(docRef: DocumentReference<unknown, DocumentData>, ...args: unknown[]) {
      queuedWrites++;
      const safeArgs = args.map((a) => (isPlainObject(a) ? sanitizeFirestoreWritePayload(a) : a));
      (inner.update as (r: unknown, ...rest: unknown[]) => unknown)(docRef, ...safeArgs);
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
  } as unknown as WriteBatch;

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
      const proxiedTx = {
        get: async <AppModelType = DocumentData, DbModelType extends DocumentData = DocumentData>(
          ref: DocumentReference<AppModelType, DbModelType>
        ) => {
          reads++;
          return tx.get(ref);
        },
        set: (ref: unknown, data: unknown, options?: SetOptions) => {
          writes++;
          const safeData = sanitizeFirestoreWritePayload(data);
          if (options) {
            (tx.set as (r: unknown, d: unknown, o: SetOptions) => unknown)(ref, safeData, options);
          } else {
            (tx.set as (r: unknown, d: unknown) => unknown)(ref, safeData);
          }
          return proxiedTx;
        },
        update: (ref: unknown, ...args: unknown[]) => {
          writes++;
          const safeArgs = args.map((a) => (isPlainObject(a) ? sanitizeFirestoreWritePayload(a) : a));
          (tx.update as (r: unknown, ...rest: unknown[]) => unknown)(ref, ...safeArgs);
          return proxiedTx;
        },
        delete: (ref: DocumentReference<unknown, DocumentData>) => {
          deletes++;
          tx.delete(ref);
          return proxiedTx;
        },
      } as unknown as Transaction;

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
export function onSnapshot<AppModelType = DocumentData, DbModelType extends DocumentData = DocumentData>(
  target: DocumentReference<AppModelType, DbModelType> | Query<AppModelType, DbModelType>,
  onNext:
    | ((snapshot: DocumentSnapshot<AppModelType, DbModelType>) => void)
    | ((snapshot: QuerySnapshot<AppModelType, DbModelType>) => void),
  onError?: (error: FirestoreError) => void
): Unsubscribe {
  const pid = resolveProjectId(target);
  let isInitialSnapshot = true;

  const emitSnap = onNext as (snap: unknown) => void;

  const wrappedNext = (
    snap: DocumentSnapshot<AppModelType, DbModelType> | QuerySnapshot<AppModelType, DbModelType>
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
    emitSnap(snap);
  };

  const wrappedError = (err: FirestoreError) => {
    if (isQuotaError(err)) reportFirestoreQuotaExhausted(pid);
    onError?.(err);
  };

  if (target.type === 'document') {
    return rawOnSnapshot(
      target as DocumentReference<AppModelType, DbModelType>,
      wrappedNext as (snap: DocumentSnapshot<AppModelType, DbModelType>) => void,
      wrappedError
    );
  }
  return rawOnSnapshot(
    target as Query<AppModelType, DbModelType>,
    wrappedNext as (snap: QuerySnapshot<AppModelType, DbModelType>) => void,
    wrappedError
  );
}
