import React, { useEffect, useState } from 'react';
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  where,
  writeBatch,
} from '../firestoreTracked';
import { BookOpen, FolderOpen, Trash2 } from 'lucide-react';
import {
  db,
  formatTimestamp,
  getTimestampMillis,
  handleFirestoreError,
  OperationType,
} from '../firebase';
import type { SavedQuestion, SavedTest, UserProfile } from '../types';
import { saveSavedTestsListSnapshot } from '../localDraftStore';
import { DUO_IMAGES, DuoArtwork, playDuoSound } from './DuoIcons';
import { DuoLoading } from './DuoLoading';
import { TestResultsView } from './TestResultsView';
import { MathText } from '../mathText';

interface SavedTestsViewProps {
  profile: UserProfile;
}

export const SavedTestsView: React.FC<SavedTestsViewProps> = ({ profile }) => {
  const [tests, setTests] = useState<SavedTest[]>([]);
  const [loading, setLoading] = useState(true);
  const [openedTest, setOpenedTest] = useState<{
    test: SavedTest;
    questions: SavedQuestion[];
  } | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const path = `users/${profile.uid}/savedTests`;
    const q = query(
      collection(db, 'users', profile.uid, 'savedTests'),
      where('ownerId', '==', profile.uid)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: SavedTest[] = [];
        snap.forEach((d) => list.push(d.data() as SavedTest));
        list.sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));
        setTests(list);
        setLoading(false);
        void saveSavedTestsListSnapshot(profile.uid, list);
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, path);
      }
    );
    return () => unsub();
  }, [profile.uid]);

  const handleOpenTest = async (test: SavedTest) => {
    setOpeningId(test.id);
    const path = `users/${profile.uid}/savedTests/${test.id}/questions`;
    try {
      const qSnap = await getDocs(
        query(
          collection(db, 'users', profile.uid, 'savedTests', test.id, 'questions'),
          where('ownerId', '==', profile.uid)
        )
      );
      const questions: SavedQuestion[] = [];
      qSnap.forEach((d) => questions.push(d.data() as SavedQuestion));
      questions.sort((a, b) => a.orderIndex - b.orderIndex);
      void saveSavedTestsListSnapshot(profile.uid, tests, { [test.id]: questions });
      setOpenedTest({ test, questions });
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, path);
    } finally {
      setOpeningId(null);
    }
  };

  const handleDeleteTest = async (testId: string) => {
    if (deleting) return;
    setDeleting(true);
    const path = `users/${profile.uid}/savedTests/${testId}`;
    try {
      const qSnap = await getDocs(
        query(
          collection(db, 'users', profile.uid, 'savedTests', testId, 'questions'),
          where('ownerId', '==', profile.uid)
        )
      );
      const batch = writeBatch(db);
      qSnap.forEach((d) => {
        batch.delete(d.ref);
      });
      batch.delete(doc(db, 'users', profile.uid, 'savedTests', testId));
      await batch.commit();
      playDuoSound('pop');
      setConfirmDeleteId(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    } finally {
      setDeleting(false);
    }
  };

  if (openedTest) {
    return (
      <TestResultsView
        profile={profile}
        archivedTest={openedTest.test}
        archivedQuestions={openedTest.questions}
        onBack={() => setOpenedTest(null)}
      />
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-black text-[#3C3C3C]">
            اختباراتي المحفوظة
          </h1>
          <p className="text-sm font-bold text-[#777777]">
            كل اختبار شاركت فيه كمشرف أو طالب محفوظ هنا بكامل أسئلته وصبوراته، ويمكنك حذفه في أي وقت.
          </p>
        </div>
        <span className="font-latin text-base font-black text-[#58CC02]">
          {tests.length} اختبار
        </span>
      </div>

      {loading ? (
        <DuoLoading
          variant="card"
          title="جاري تحميل أرشيف اختباراتك المحفوظة..."
          subtitle="يتم استرجاع جميع الجلسات والأسئلة من قاعدة البيانات"
          accent="blue"
        />
      ) : tests.length === 0 ? (
        <div className="duo-card p-10 flex flex-col items-center justify-center text-center gap-4">
          <DuoArtwork
            src={DUO_IMAGES.welcome}
            alt="لا توجد اختبارات محفوظة بعد"
            className="w-28 h-28"
          />
          <div>
            <h2 className="text-xl font-black text-[#3C3C3C] mb-1">
              لا توجد اختبارات محفوظة بعد
            </h2>
            <p className="text-sm font-bold text-[#777777]">
              عند إنهاء أي جلسة اختبار ستُحفظ تلقائياً هنا بجميع صبوراتها.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {tests.map((test) => (
            <div
              key={test.id}
              className="duo-card p-5 flex flex-col justify-between gap-4"
            >
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2 text-xs font-extrabold text-[#777777]">
                  <span>
                    {test.userRole === 'supervisor' ? 'دورك: مشرف' : 'دورك: طالب'}
                  </span>
                  <span>{formatTimestamp(test.createdAt)}</span>
                </div>
                <h2 className="text-lg font-black text-[#3C3C3C] break-words leading-relaxed">
                  <MathText text={test.title} inline />
                </h2>
                <p className="text-xs font-bold text-[#777777]">
                  المشرف: <span className="text-[#3C3C3C]">{test.supervisorName}</span>
                  {' · '}
                  رمز الغرفة:{' '}
                  <span className="font-latin font-black text-[#1CB0F6]">
                    {test.roomCode}
                  </span>
                  {' · '}
                  الأسئلة:{' '}
                  <span className="font-latin font-black text-[#3C3C3C]">
                    {test.totalQuestions}
                  </span>
                </p>
              </div>

              <div className="flex items-center gap-2.5 pt-2 border-t-2 border-[#F0F0F0]">
                <button
                  type="button"
                  disabled={openingId === test.id}
                  onClick={() => handleOpenTest(test)}
                  className="duo-btn flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-[#1899D6] border-b-4 text-white text-sm font-black cursor-pointer disabled:opacity-60 whitespace-nowrap"
                >
                  {openingId === test.id ? (
                    <BookOpen className="w-4 h-4" />
                  ) : (
                    <FolderOpen className="w-4 h-4" />
                  )}
                  <span>
                    {openingId === test.id ? 'جاري الفتح...' : 'عرض الاختبار والصبورات'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(test.id)}
                  title="حذف الاختبار"
                  className="duo-btn flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] hover:border-[#FF4B4B] hover:bg-[#FFDFE0] text-[#EA2B2B] text-sm font-black cursor-pointer whitespace-nowrap"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>حذف</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="duo-card max-w-md w-full p-6 flex flex-col gap-4 text-center">
            <h3 className="text-xl font-black text-[#3C3C3C]">
              حذف الاختبار المحفوظ؟
            </h3>
            <p className="text-sm font-bold text-[#777777]">
              سيتم حذف هذا الاختبار وجميع أسئلته وصبوراته من حسابك نهائياً.
            </p>
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                className="duo-btn flex-1 py-3 rounded-2xl bg-white border-2 border-b-4 border-[#E5E5E5] text-sm font-black text-[#3C3C3C] cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => handleDeleteTest(confirmDeleteId)}
                className="duo-btn flex-1 py-3 rounded-2xl bg-[#FF4B4B] border-2 border-b-4 border-[#EA2B2B] text-sm font-black text-white cursor-pointer disabled:opacity-60"
              >
                {deleting ? 'جاري الحذف...' : 'نعم، احذف الاختبار'}
              </button>
            </div>
          </div>
        </div>
      )}

      {openingId && (
        <DuoLoading
          variant="overlay"
          title="جاري فتح الاختبار واسترجاع جميع الصبورات..."
          subtitle="يتم تحميل الأسئلة وإجابات الطلاب والرسوم الهندسية"
          accent="blue"
        />
      )}
    </div>
  );
};
