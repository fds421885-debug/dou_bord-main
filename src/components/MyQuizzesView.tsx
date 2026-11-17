import React, { useEffect, useRef, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import {
  ArrowRight,
  CheckCircle2,
  ClipboardCopy,
  Download,
  FileJson,
  FilePlus2,
  FolderOpen,
  History,
  Pencil,
  Play,
  Trash2,
  Upload,
} from 'lucide-react';
import { db, formatTimestamp, getTimestampMillis } from '../firebase';
import type { ExamQuestion, ExamSettings, MyQuiz, QuizAttempt, QuizQuestion, UserProfile } from '../types';
import {
  deleteSessionSnapshot,
  loadSessionSnapshot,
  saveMyQuizzesSnapshot,
  saveSessionSnapshot,
  type StoredExamSession,
  type StoredMyQuizDraft,
  type StoredMyQuizzesSnapshot,
  type StoredQuizAttemptsSnapshot,
} from '../localDraftStore';
import { deleteMyQuiz, EXAMPLE_JSON, IMPORT_PROMPT, parseQuizJson, quizToExportJson } from '../myQuizzes';
import { ChartView } from './ChartView';
import { FigureView } from './FigureView';
import { ExamSetup } from './ExamSetup';
import { ExamRunner, type ExamInitialState } from './ExamRunner';
import { ExamResult } from './ExamResult';
import { ExamReview } from './ExamReview';
import { deleteAttempt, describeTiming, formatDuration, newAttemptId } from '../exam';
import { MathText } from '../mathText';
import { QuizEditor } from './QuizEditor';
import { DuoLoading } from './DuoLoading';

type Mode =
  | { kind: 'list' }
  | { kind: 'import' }
  | {
      kind: 'edit';
      editingId: string | null;
      title: string;
      questions: QuizQuestion[];
      warnings: string[];
    }
  | { kind: 'view'; quiz: MyQuiz }
  | { kind: 'examSetup' }
  | { kind: 'examRun'; settings: ExamSettings; questions: ExamQuestion[]; initial?: ExamInitialState }
  | {
      kind: 'examResult';
      attemptId: string;
      settings: ExamSettings;
      questions: ExamQuestion[];
      answers: number[];
      durationSec: number;
      finishedAt: number;
    }
  | { kind: 'attempt'; attempt: QuizAttempt };

interface Props {
  profile: UserProfile;
}

const card = 'rounded-3xl border-2 border-[#E5E5E5] border-b-4 bg-white';

export const MyQuizzesView: React.FC<Props> = ({ profile }) => {
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [quizzes, setQuizzes] = useState<MyQuiz[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<StoredMyQuizDraft | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [attempts, setAttempts] = useState<QuizAttempt[]>([]);
  const [session, setSession] = useState<StoredExamSession | null>(null);
  const [confirmDeleteAttemptId, setConfirmDeleteAttemptId] = useState<string | null>(null);

  const refreshDraft = async () => {
    const d = await loadSessionSnapshot<StoredMyQuizDraft>('my_quiz_draft');
    const has = d && d.ownerId === profile.uid && (d.title.trim() || d.questions.some((q) => q.text.trim()));
    setDraft(has ? d : null);
    const sess = await loadSessionSnapshot<StoredExamSession>('exam_session');
    setSession(sess && sess.ownerId === profile.uid && sess.questions?.length ? sess : null);
  };

  useEffect(() => {
    let alive = true;
    // 1) نعرض النسخة المحلية فوراً (تعمل حتى لو الحصة منتهية)
    void loadSessionSnapshot<StoredMyQuizzesSnapshot>('my_quizzes').then((snap) => {
      if (alive && snap && snap.ownerId === profile.uid) {
        setQuizzes(snap.quizzes);
        setLoading(false);
      }
    });
    void refreshDraft();

    // 2) ثم الاشتراك الحي في Firestore
    const unsub = onSnapshot(
      query(collection(db, 'users', profile.uid, 'myQuizzes'), where('ownerId', '==', profile.uid)),
      (snap) => {
        const list: MyQuiz[] = [];
        snap.forEach((d) => list.push(d.data() as MyQuiz));
        list.sort((a, b) => getTimestampMillis(b.updatedAt) - getTimestampMillis(a.updatedAt));
        setQuizzes(list);
        setLoading(false);
        setLoadError(null);
        void saveMyQuizzesSnapshot(profile.uid, list);
      },
      (err) => {
        console.error('myQuizzes listener error', err);
        const m = String(err?.message || '');
        setLoadError(
          /permission/i.test(m)
            ? 'تعذر قراءة اختباراتي: قواعد الأمان في قاعدة البيانات لم تُحدَّث بعد (انسخ firestore.rules وانشرها في Firebase).'
            : /quota|exhausted/i.test(m)
            ? 'حصة قاعدة البيانات منتهية مؤقتاً، تُعرض النسخة المحفوظة على جهازك.'
            : 'تعذر الاتصال بقاعدة البيانات، تُعرض النسخة المحفوظة على جهازك.'
        );
        setLoading(false);
      }
    );
    void loadSessionSnapshot<StoredQuizAttemptsSnapshot>('quiz_attempts').then((snap) => {
      if (alive && snap && snap.ownerId === profile.uid) setAttempts(snap.attempts);
    });
    const unsubAttempts = onSnapshot(
      query(collection(db, 'users', profile.uid, 'quizAttempts'), where('ownerId', '==', profile.uid)),
      (snap) => {
        const list: QuizAttempt[] = [];
        snap.forEach((d) => list.push(d.data() as QuizAttempt));
        list.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
        setAttempts(list);
        void saveSessionSnapshot({
          key: 'quiz_attempts',
          ownerId: profile.uid,
          attempts: list.slice(0, 30),
          updatedAt: Date.now(),
        });
      },
      (err) => {
        console.error('quizAttempts listener error', err);
      }
    );
    return () => {
      alive = false;
      unsub();
      unsubAttempts();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.uid]);

  const finish = (msg: string) => {
    setNotice(msg);
    setMode({ kind: 'list' });
    void refreshDraft();
    window.setTimeout(() => setNotice(null), 4000);
  };

  const exportQuiz = (quiz: MyQuiz) => {
    const blob = new Blob([quizToExportJson(quiz.title, quiz.questions)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${quiz.title.replace(/[^\w\u0600-\u06FF\- ]+/g, '').trim() || 'quiz'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const confirmDelete = async (id: string) => {
    setDeleting(true);
    try {
      await deleteMyQuiz(profile.uid, id);
      setConfirmDeleteId(null);
    } catch {
      setNotice('تعذر الحذف، حاول مرة أخرى.');
    } finally {
      setDeleting(false);
    }
  };

  /* ---------------- وضع الاختبار ---------------- */
  if (mode.kind === 'examSetup') {
    return (
      <ExamSetup
        quizzes={quizzes}
        onBack={() => setMode({ kind: 'list' })}
        onStart={(settings, questions) => {
          void deleteSessionSnapshot('exam_session');
          setMode({ kind: 'examRun', settings, questions });
        }}
      />
    );
  }

  if (mode.kind === 'examRun') {
    return (
      <ExamRunner
        key={mode.questions.map((q) => q.id).join('|')}
        ownerId={profile.uid}
        settings={mode.settings}
        questions={mode.questions}
        initial={mode.initial}
        onExit={() => {
          setMode({ kind: 'list' });
          void refreshDraft();
        }}
        onFinish={(answers, durationSec) =>
          setMode({
            kind: 'examResult',
            attemptId: newAttemptId(),
            settings: mode.settings,
            questions: mode.questions,
            answers,
            durationSec,
            finishedAt: Date.now(),
          })
        }
      />
    );
  }

  if (mode.kind === 'examResult') {
    return (
      <ExamResult
        key={mode.attemptId}
        ownerId={profile.uid}
        attemptId={mode.attemptId}
        settings={mode.settings}
        questions={mode.questions}
        answers={mode.answers}
        durationSec={mode.durationSec}
        finishedAt={mode.finishedAt}
        onBack={() => {
          setMode({ kind: 'list' });
          void refreshDraft();
        }}
        onRetake={() => setMode({ kind: 'examSetup' })}
      />
    );
  }

  if (mode.kind === 'attempt') {
    const a = mode.attempt;
    return (
      <div className="max-w-3xl mx-auto w-full flex flex-col gap-4" dir="rtl">
        <button type="button" onClick={() => setMode({ kind: 'list' })} className="self-start flex items-center gap-1 text-xs font-black text-[#777777] cursor-pointer">
          <ArrowRight className="w-4 h-4" /> العودة إلى اختباراتي
        </button>
        <div>
          <h2 className="text-lg font-black text-[#3C3C3C]">{a.title}</h2>
          <p className="text-[11px] font-extrabold text-[#777777]">
            {new Date(a.finishedAt).toLocaleString('ar')} · {describeTiming(a.settings)}
          </p>
        </div>
        <ExamReview questions={a.questions} answers={a.answers} score={a.score} total={a.total} durationSec={a.durationSec} />
      </div>
    );
  }

  /* ---------------- تحرير / إنشاء ---------------- */
  if (mode.kind === 'edit') {
    return (
      <div className="max-w-3xl mx-auto w-full flex flex-col gap-4">
        <button
          type="button"
          onClick={() => {
            setMode({ kind: 'list' });
            void refreshDraft();
          }}
          className="self-start flex items-center gap-1 text-xs font-black text-[#777777] cursor-pointer"
        >
          <ArrowRight className="w-4 h-4" /> العودة إلى اختباراتي
        </button>
        <h2 className="text-lg font-black text-[#3C3C3C]">
          {mode.editingId ? 'تعديل الاختبار' : 'مراجعة وإضافة الاختبار'}
        </h2>
        <QuizEditor
          ownerId={profile.uid}
          editingId={mode.editingId}
          initialTitle={mode.title}
          initialQuestions={mode.questions}
          warnings={mode.warnings}
          onDone={finish}
          onCancel={() => {
            setMode({ kind: 'list' });
            void refreshDraft();
          }}
        />
      </div>
    );
  }

  /* ---------------- استيراد ---------------- */
  if (mode.kind === 'import') {
    return <ImportPanel onBack={() => setMode({ kind: 'list' })} onParsed={(title, questions, warnings) =>
      setMode({ kind: 'edit', editingId: null, title, questions, warnings })} />;
  }

  /* ---------------- عرض اختبار ---------------- */
  if (mode.kind === 'view') {
    const q = mode.quiz;
    return (
      <div className="max-w-3xl mx-auto w-full flex flex-col gap-4">
        <button type="button" onClick={() => setMode({ kind: 'list' })} className="self-start flex items-center gap-1 text-xs font-black text-[#777777] cursor-pointer">
          <ArrowRight className="w-4 h-4" /> العودة إلى اختباراتي
        </button>
        <h2 className="text-lg font-black text-[#3C3C3C]">{q.title}</h2>
        {q.questions.map((qq, i) => (
          <div key={qq.id} className={`${card} p-4 flex flex-col gap-2`}>
            <span className="self-start px-3 py-1 rounded-full bg-[#DDF4FF] text-[#1899D6] text-xs font-black">السؤال {i + 1}</span>
            <MathText text={qq.text} className="text-sm font-black text-[#3C3C3C]" />
            {qq.chart && <ChartView chart={qq.chart} />}
            {qq.figure && <FigureView figure={qq.figure} />}
            {qq.choices.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {qq.choices.map((c, ci) => (
                  <div key={ci} className={`flex items-center gap-2 px-3 py-2 rounded-2xl border-2 text-sm font-bold ${ci === qq.correctIndex ? 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]' : 'bg-white border-[#E5E5E5] text-[#3C3C3C]'}`}>
                    {ci === qq.correctIndex && <CheckCircle2 className="w-4 h-4 shrink-0" />}
                    <MathText text={c} />
                  </div>
                ))}
              </div>
            ) : qq.answer ? (
              <div className="px-3 py-2 rounded-2xl bg-[#D7FFB8] border-2 border-[#58CC02] text-sm font-bold text-[#46A302]">
                <MathText text={qq.answer} />
              </div>
            ) : null}
            {(qq.explanation || qq.explanationChart || qq.explanationFigure) && (
              <div className="px-3.5 py-2.5 rounded-2xl bg-[#F7F7F7] border border-[#E5E5E5] text-xs sm:text-sm font-bold text-[#3C3C3C] flex flex-col gap-2">
                <span className="font-black text-[#777777] text-[11px]">شرح الإجابة:</span>
                {qq.explanation && <MathText text={qq.explanation} />}
                {qq.explanationChart && <ChartView chart={qq.explanationChart} />}
                {qq.explanationFigure && <FigureView figure={qq.explanationFigure} />}
              </div>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => setMode({ kind: 'edit', editingId: q.id, title: q.title, questions: q.questions.map((x) => JSON.parse(JSON.stringify(x)) as QuizQuestion), warnings: [] })}
          className="duo-btn self-start flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#1CB0F6] border-2 border-[#1899D6] border-b-4 text-white text-sm font-black cursor-pointer"
        >
          <Pencil className="w-4 h-4" /> تعديل
        </button>
      </div>
    );
  }

  /* ---------------- القائمة ---------------- */
  return (
    <div className="max-w-3xl mx-auto w-full flex flex-col gap-4" dir="rtl">
      <div>
        <h2 className="text-xl font-black text-[#3C3C3C]">اختباراتي</h2>
        <p className="text-xs font-bold text-[#777777]">أنشئ اختباراتك بنفسك أو استوردها من ملف JSON، ثم راجعها وعدّلها واحفظها.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setMode({ kind: 'examSetup' })}
          disabled={quizzes.length === 0}
          className="duo-btn sm:col-span-2 flex items-center gap-3 p-4 rounded-3xl bg-[#A560E8] border-2 border-[#8938D6] border-b-4 text-white text-right cursor-pointer disabled:opacity-50"
        >
          <Play className="w-7 h-7 shrink-0" />
          <span>
            <span className="block text-base font-black">بدء اختبار</span>
            <span className="block text-[11px] font-bold opacity-90">اختر نموذجاً أو امزج عدة نماذج، وحدد العدد والوقت</span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setMode({ kind: 'edit', editingId: null, title: '', questions: [], warnings: [] })}
          className="duo-btn flex items-center gap-3 p-4 rounded-3xl bg-[#58CC02] border-2 border-[#46A302] border-b-4 text-white text-right cursor-pointer"
        >
          <FilePlus2 className="w-7 h-7 shrink-0" />
          <span>
            <span className="block text-base font-black">إنشاء اختبار</span>
            <span className="block text-[11px] font-bold opacity-90">اكتب الأسئلة بنفسك مع رموز الرياضيات</span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setMode({ kind: 'import' })}
          className="duo-btn flex items-center gap-3 p-4 rounded-3xl bg-[#1CB0F6] border-2 border-[#1899D6] border-b-4 text-white text-right cursor-pointer"
        >
          <FileJson className="w-7 h-7 shrink-0" />
          <span>
            <span className="block text-base font-black">استيراد اختبار</span>
            <span className="block text-[11px] font-bold opacity-90">من ملف JSON بسكريبت جاهز للذكاء الاصطناعي</span>
          </span>
        </button>
      </div>

      {session && (
        <div className="rounded-2xl border-2 border-[#A560E8] bg-[#F5ECFF] p-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-extrabold text-[#5C1A99]">
            {session.finished
              ? 'لديك نتيجة اختبار لم تُحفظ بعد.'
              : `لديك اختبار غير مكتمل (${session.answers.filter((a) => a >= 0).length} من ${session.questions.length} مُجاب) — تابع من حيث توقفت.`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                session.finished
                  ? setMode({
                      kind: 'examResult',
                      attemptId: newAttemptId(),
                      settings: session.settings,
                      questions: session.questions,
                      answers: session.answers,
                      durationSec: Math.round(session.elapsedMs / 1000),
                      finishedAt: session.updatedAt,
                    })
                  : setMode({
                      kind: 'examRun',
                      settings: session.settings,
                      questions: session.questions,
                      initial: {
                        answers: session.answers,
                        index: session.index,
                        remainingMs: session.remainingMs,
                        elapsedMs: session.elapsedMs,
                      },
                    })
              }
              className="px-3 py-1.5 rounded-xl bg-[#A560E8] border-2 border-[#8938D6] border-b-4 text-xs font-black text-white cursor-pointer"
            >
              {session.finished ? 'عرض وحفظ النتيجة' : 'متابعة الاختبار'}
            </button>
            <button
              type="button"
              onClick={async () => {
                await deleteSessionSnapshot('exam_session');
                setSession(null);
              }}
              className="px-3 py-1.5 rounded-xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#EA2B2B] cursor-pointer"
            >
              تجاهل
            </button>
          </div>
        </div>
      )}

      {draft && (
        <div className="rounded-2xl border-2 border-[#FFC800] bg-[#FFF4CC] p-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-extrabold text-[#8A6500]">
            لديك مسودة لم تُحفظ بعد{draft.title ? `: «${draft.title}»` : ''} — تابع من حيث توقفت.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode({ kind: 'edit', editingId: draft.editingId, title: draft.title, questions: draft.questions, warnings: [] })}
              className="px-3 py-1.5 rounded-xl bg-[#FFC800] border-2 border-[#E5A400] border-b-4 text-xs font-black text-white cursor-pointer"
            >
              متابعة المسودة
            </button>
            <button
              type="button"
              onClick={async () => {
                await deleteSessionSnapshot('my_quiz_draft');
                setDraft(null);
              }}
              className="px-3 py-1.5 rounded-xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#EA2B2B] cursor-pointer"
            >
              تجاهل
            </button>
          </div>
        </div>
      )}

      {notice && (
        <div className="p-3 rounded-2xl bg-[#D7FFB8] border-2 border-[#58CC02] text-xs font-extrabold text-[#46A302]">{notice}</div>
      )}
      {loadError && (
        <div className="p-3 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-xs font-extrabold text-[#EA2B2B]">{loadError}</div>
      )}

      {loading ? (
        <DuoLoading
          variant="card"
          title="جاري تحميل نماذج اختباراتك وسجلاتك..."
          subtitle="يتم مزامنة الأسئلة والأشكال الهندسية والرسوم البيانية"
          accent="purple"
        />
      ) : quizzes.length === 0 ? (
        <div className={`${card} p-8 text-center text-sm font-bold text-[#777777]`}>
          لا توجد اختبارات بعد. ابدأ بإنشاء اختبار أو استيراده.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {quizzes.map((q) => (
            <div key={q.id} className={`${card} p-4 flex flex-col gap-3`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-base font-black text-[#3C3C3C] truncate">{q.title}</h3>
                  <p className="text-[11px] font-extrabold text-[#777777]">
                    {q.questionCount} سؤال · آخر تعديل {formatTimestamp(q.updatedAt)}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => setMode({ kind: 'view', quiz: q })} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#DDF4FF] border-2 border-[#1CB0F6] text-xs font-black text-[#1899D6] cursor-pointer">
                  <FolderOpen className="w-3.5 h-3.5" /> فتح
                </button>
                <button type="button" onClick={() => setMode({ kind: 'edit', editingId: q.id, title: q.title, questions: q.questions.map((x) => JSON.parse(JSON.stringify(x)) as QuizQuestion), warnings: [] })} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer">
                  <Pencil className="w-3.5 h-3.5" /> تعديل
                </button>
                <button type="button" onClick={() => exportQuiz(q)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer">
                  <Download className="w-3.5 h-3.5" /> تصدير JSON
                </button>
                {confirmDeleteId === q.id ? (
                  <span className="flex items-center gap-2 text-xs font-black">
                    <button type="button" disabled={deleting} onClick={() => void confirmDelete(q.id)} className="px-3 py-1.5 rounded-xl bg-[#FF4B4B] text-white cursor-pointer">
                      {deleting ? '...' : 'تأكيد الحذف'}
                    </button>
                    <button type="button" onClick={() => setConfirmDeleteId(null)} className="text-[#777777] cursor-pointer">إلغاء</button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setConfirmDeleteId(q.id)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#EA2B2B] cursor-pointer">
                    <Trash2 className="w-3.5 h-3.5" /> حذف
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {attempts.length > 0 && (
        <div className="flex flex-col gap-3 mt-2">
          <h3 className="flex items-center gap-2 text-base font-black text-[#3C3C3C]">
            <History className="w-5 h-5 text-[#8938D6]" /> محاولاتي السابقة
          </h3>
          {attempts.slice(0, 30).map((a) => {
            const pct = a.total > 0 ? Math.round((a.score / a.total) * 100) : 0;
            const tone = pct >= 85 ? 'text-[#46A302]' : pct >= 50 ? 'text-[#8A6500]' : 'text-[#EA2B2B]';
            return (
              <div key={a.id} className={`${card} p-4 flex flex-col gap-2`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="text-sm font-black text-[#3C3C3C] truncate">{a.title}</h4>
                    <p className="text-[11px] font-extrabold text-[#777777]">
                      {new Date(a.finishedAt).toLocaleString('ar')} · {describeTiming(a.settings)} · {formatDuration(a.durationSec)}
                    </p>
                  </div>
                  <div dir="ltr" className={`text-lg font-black font-latin shrink-0 ${tone}`}>
                    {a.score}/{a.total} <span className="text-xs">({pct}%)</span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => setMode({ kind: 'attempt', attempt: a })} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#F5ECFF] border-2 border-[#A560E8] text-xs font-black text-[#8938D6] cursor-pointer">
                    <FolderOpen className="w-3.5 h-3.5" /> مراجعة
                  </button>
                  {confirmDeleteAttemptId === a.id ? (
                    <span className="flex items-center gap-2 text-xs font-black">
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await deleteAttempt(profile.uid, a.id);
                          } catch {
                            setNotice('تعذر حذف المحاولة، حاول مرة أخرى.');
                          }
                          setConfirmDeleteAttemptId(null);
                        }}
                        className="px-3 py-1.5 rounded-xl bg-[#FF4B4B] text-white cursor-pointer"
                      >
                        تأكيد الحذف
                      </button>
                      <button type="button" onClick={() => setConfirmDeleteAttemptId(null)} className="text-[#777777] cursor-pointer">إلغاء</button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => setConfirmDeleteAttemptId(a.id)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#EA2B2B] cursor-pointer">
                      <Trash2 className="w-3.5 h-3.5" /> حذف
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/* ===================== لوحة الاستيراد ===================== */

const ImportPanel: React.FC<{
  onBack: () => void;
  onParsed: (title: string, questions: QuizQuestion[], warnings: string[]) => void;
}> = ({ onBack, onParsed }) => {
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(IMPORT_PROMPT);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setShowPrompt(true);
    }
  };

  const read = () => {
    try {
      const res = parseQuizJson(raw);
      onParsed(res.title, res.questions, res.warnings);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر قراءة الملف.');
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 3_000_000) {
      setError('الملف كبير جداً (الحد 3MB).');
      return;
    }
    setRaw(await f.text());
    setError(null);
  };

  return (
    <div className="max-w-3xl mx-auto w-full flex flex-col gap-4" dir="rtl">
      <button type="button" onClick={onBack} className="self-start flex items-center gap-1 text-xs font-black text-[#777777] cursor-pointer">
        <ArrowRight className="w-4 h-4" /> العودة إلى اختباراتي
      </button>
      <h2 className="text-lg font-black text-[#3C3C3C]">استيراد اختبار من JSON</h2>

      <div className={`${card} p-4 flex flex-col gap-3`}>
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-full bg-[#1CB0F6] text-white text-xs font-black flex items-center justify-center">1</span>
          <h3 className="text-sm font-black text-[#3C3C3C]">انسخ السكريبت وأعطه للذكاء الاصطناعي</h3>
        </div>
        <p className="text-xs font-bold text-[#777777]">
          الصق السكريبت في أي ذكاء اصطناعي (ChatGPT / Claude / Gemini) ثم أضف تحته مادتك أو أسئلتك. سيعطيك ملف JSON جاهزاً بنفس الصيغة،
          بالجذور والكسور مكتوبة بالشكل الصحيح.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void copyPrompt()} className="duo-btn flex items-center gap-2 px-4 py-2 rounded-2xl bg-[#1CB0F6] border-2 border-[#1899D6] border-b-4 text-white text-sm font-black cursor-pointer">
            <ClipboardCopy className="w-4 h-4" /> {copied ? 'تم النسخ ✓' : 'نسخ السكريبت'}
          </button>
          <button type="button" onClick={() => setShowPrompt((v) => !v)} className="text-xs font-black text-[#1899D6] cursor-pointer">
            {showPrompt ? 'إخفاء السكريبت' : 'عرض السكريبت'}
          </button>
        </div>
        {showPrompt && (
          <pre dir="rtl" className="max-h-72 overflow-auto whitespace-pre-wrap rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] p-3 text-[11px] leading-relaxed font-bold text-[#3C3C3C]">
            {IMPORT_PROMPT}
          </pre>
        )}
      </div>

      <div className={`${card} p-4 flex flex-col gap-2`}>
        <h3 className="text-sm font-black text-[#3C3C3C]">كيف تُضاف الأشكال الهندسية والرسوم البيانية؟</h3>
        <ul className="text-xs font-bold text-[#555] leading-relaxed list-disc pr-5 flex flex-col gap-1">
          <li>كل الأسئلة باختيارات: <span className="font-latin">choices</span> مصفوفة الخيارات، و <span className="font-latin">correctIndex</span> رقم الخيار الصحيح ويبدأ من 0.</li>
          <li>للأشكال الهندسية البسيطة والمركّبة (مثلثات، زوايا متقابلة، متوازيان وقاطع، دائرة داخل مربع، مجاهيل <span className="font-latin">س / x</span>): يضيف السكريبت الحقل <span className="font-latin">figure</span> تلقائياً ويرسمها البرنامج متجهياً بدقة.</li>
          <li>للأعمدة والخطوط والقطاعات الدائرية: يضيف الحقل <span className="font-latin">chart</span> بأنواعه (<span className="font-latin">bar / hbar / line / pie</span>).</li>
          <li>بعد الاستيراد تستطيع تعديل الأشكال الهندسية والزوايا والأطوال والرسوم والشرح من شاشة التعديل.</li>
        </ul>
        <button
          type="button"
          onClick={() => {
            setRaw(EXAMPLE_JSON);
            setError(null);
          }}
          className="self-start text-xs font-black text-[#7C3AED] hover:underline cursor-pointer"
        >
          تجربة مثال كامل (هندسة مركبة + أعمدة + دائري + جذور)
        </button>
      </div>

      <div className={`${card} p-4 flex flex-col gap-3`}>
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-full bg-[#58CC02] text-white text-xs font-black flex items-center justify-center">2</span>
          <h3 className="text-sm font-black text-[#3C3C3C]">الصق ملف JSON هنا (أو ارفعه)</h3>
        </div>
        <textarea
          dir="ltr"
          rows={10}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setError(null);
          }}
          placeholder={'{ "title": "...", "questions": [ ... ] }'}
          className="w-full rounded-2xl border-2 border-[#E5E5E5] focus:border-[#1CB0F6] outline-none p-3 text-xs font-latin leading-relaxed bg-[#F7F7F7]"
        />
        <input ref={fileRef} type="file" accept=".json,application/json,text/plain" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
        {error && (
          <div className="p-3 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-xs font-extrabold text-[#EA2B2B]">{error}</div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={read} disabled={!raw.trim()} className="duo-btn flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#58CC02] border-2 border-[#46A302] border-b-4 text-white text-sm font-black cursor-pointer disabled:opacity-50">
            عرض الأسئلة ومراجعتها
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-white border-2 border-[#E5E5E5] border-b-4 text-sm font-black text-[#3C3C3C] cursor-pointer">
            <Upload className="w-4 h-4" /> رفع ملف
          </button>
        </div>
      </div>
    </div>
  );
};
