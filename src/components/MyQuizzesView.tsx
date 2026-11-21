import React, { useEffect, useMemo, useRef, useState } from 'react';
import { collection, onSnapshot, query, where } from '../firestoreTracked';
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ClipboardCopy,
  Download,
  Dumbbell,
  Eye,
  EyeOff,
  FileJson,
  FilePlus2,
  FolderOpen,
  History,
  Layers,
  ListChecks,
  Loader2,
  Pencil,
  Play,
  Sparkles,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { db, formatTimestamp, getTimestampMillis } from '../firebase';
import type {
  DrillStyle,
  ExamQuestion,
  ExamSettings,
  MyQuiz,
  QuizAttempt,
  QuizQuestion,
  StarredQuestion,
  UserProfile,
} from '../types';
import {
  deleteSessionSnapshot,
  loadMyQuizMetaOverrides,
  loadSessionSnapshot,
  saveMyQuizzesSnapshot,
  saveSessionSnapshot,
  type MyQuizMetaOverride,
  type StoredExamSession,
  type StoredMyQuizDraft,
  type StoredMyQuizzesSnapshot,
  type StoredQuizAttemptsSnapshot,
} from '../localDraftStore';
import {
  buildMainImportPrompt,
  createMyQuizzesAutoSplit,
  deleteMyQuiz,
  EXAMPLE_JSON,
  formatQuizSaveError,
  parseQuizBundleJson,
  quizToExportJson,
  type ParsedQuizBundle,
} from '../myQuizzes';
import { decodeExamAttemptFromFirestore, decodeMyQuizFromFirestore } from '../quizTable';
import { removeStarredQuestion, subscribeStarredQuestions } from '../starredQuestions';
import { ChartView } from './ChartView';
import { FigureView } from './FigureView';
import { QuestionLawsBox } from './QuestionLawsBox';
import { QuestionTableView } from './QuestionTableView';
import { RichExplanationView } from './RichExplanationView';
import { CreateDrillModal } from './CreateDrillModal';
import { ExamSetup } from './ExamSetup';
import { ExamRunner, type ExamInitialState } from './ExamRunner';
import { ExamResult } from './ExamResult';
import { ExamReview } from './ExamReview';
import {
  buildExam,
  deleteAttempt,
  describeTiming,
  formatDuration,
  isExamReady,
  isQuestionAnswered,
  newAttemptId,
} from '../exam';
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
      tableAnswers?: Record<string, Record<string, string>>;
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
  const [subTab, setSubTab] = useState<'quizzes' | 'starred'>('quizzes');
  const [quizzes, setQuizzes] = useState<MyQuiz[]>([]);
  const [starredItems, setStarredItems] = useState<StarredQuestion[]>([]);
  const [revealedStarExplanations, setRevealedStarExplanations] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<StoredMyQuizDraft | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [attempts, setAttempts] = useState<QuizAttempt[]>([]);
  const [session, setSession] = useState<StoredExamSession | null>(null);
  const [confirmDeleteAttemptId, setConfirmDeleteAttemptId] = useState<string | null>(null);
  const [metaOverrides, setMetaOverrides] = useState<Record<string, MyQuizMetaOverride>>({});
  const [drillModalTarget, setDrillModalTarget] = useState<{
    question: QuizQuestion;
    sourceTitle?: string;
    sourceQuizId?: string;
    sourceStarredId?: string;
  } | null>(null);
  const [pendingLawsChoice, setPendingLawsChoice] = useState<
    | { kind: 'quiz'; quiz: MyQuiz; lawsCount: number }
    | { kind: 'starred'; lawsCount: number }
    | null
  >(null);

  const reloadMetaOverrides = async () => {
    const map = await loadMyQuizMetaOverrides(profile.uid);
    setMetaOverrides(map);
  };

  const refreshDraft = async () => {
    const d = await loadSessionSnapshot<StoredMyQuizDraft>('my_quiz_draft');
    const has = d && d.ownerId === profile.uid && (d.title.trim() || d.questions.some((q) => q.text.trim()));
    setDraft(has ? d : null);
    const sess = await loadSessionSnapshot<StoredExamSession>('exam_session');
    setSession(sess && sess.ownerId === profile.uid && sess.questions?.length ? sess : null);
  };

  useEffect(() => {
    let alive = true;
    void reloadMetaOverrides();
    // 1) نعرض النسخة المحلية فوراً (تعمل حتى لو الحصة منتهية)
    void loadSessionSnapshot<StoredMyQuizzesSnapshot>('my_quizzes').then((snap) => {
      if (alive && snap && snap.ownerId === profile.uid) {
        setQuizzes(snap.quizzes.map(decodeMyQuizFromFirestore));
        setLoading(false);
      }
    });
    void refreshDraft();

    // 2) ثم الاشتراك الحي في Firestore
    const unsub = onSnapshot(
      query(collection(db, 'users', profile.uid, 'myQuizzes'), where('ownerId', '==', profile.uid)),
      (snap) => {
        const list: MyQuiz[] = [];
        snap.forEach((d) => list.push(decodeMyQuizFromFirestore(d.data() as MyQuiz)));
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
          /permission|insufficient/i.test(m)
            ? 'تعذر قراءة اختباراتي: قواعد الأمان في قاعدة البيانات لم تُحدَّث بعد (انسخ firestore.rules وانشرها في Firebase).'
            : /quota|exhausted/i.test(m)
            ? 'حصة قاعدة البيانات منتهية مؤقتاً، تُعرض النسخة المحفوظة على جهازك.'
            : 'تعذر الاتصال بقاعدة البيانات، تُعرض النسخة المحفوظة على جهازك.'
        );
        setLoading(false);
      }
    );
    void loadSessionSnapshot<StoredQuizAttemptsSnapshot>('quiz_attempts').then((snap) => {
      if (alive && snap && snap.ownerId === profile.uid) {
        setAttempts(snap.attempts.map(decodeExamAttemptFromFirestore));
      }
    });
    const unsubAttempts = onSnapshot(
      query(collection(db, 'users', profile.uid, 'quizAttempts'), where('ownerId', '==', profile.uid)),
      (snap) => {
        const list: QuizAttempt[] = [];
        snap.forEach((d) => list.push(decodeExamAttemptFromFirestore(d.data() as QuizAttempt)));
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
    const unsubStarred = subscribeStarredQuestions(profile.uid, (items) => {
      if (alive) setStarredItems(items);
    });
    return () => {
      alive = false;
      unsub();
      unsubAttempts();
      unsubStarred();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.uid]);

  const mergedQuizzes = useMemo<MyQuiz[]>(() => {
    return quizzes.map((q) => {
      const ov = metaOverrides[q.id];
      if (!ov) return q;
      return {
        ...q,
        parentQuizId: q.parentQuizId ?? ov.parentQuizId,
        quizKind: q.quizKind ?? ov.quizKind,
        drillStyle: q.drillStyle ?? ov.drillStyle,
        sourceStarredId: q.sourceStarredId ?? ov.sourceStarredId,
        ruleTitle: q.ruleTitle ?? ov.ruleTitle,
      };
    });
  }, [quizzes, metaOverrides]);

  const { mainQuizzes, childrenByParentId, standaloneDrills } = useMemo(() => {
    const idSet = new Set(mergedQuizzes.map((q) => q.id));
    const mains: MyQuiz[] = [];
    const byParent: Record<string, MyQuiz[]> = {};
    const orphans: MyQuiz[] = [];

    for (const q of mergedQuizzes) {
      if (q.parentQuizId && idSet.has(q.parentQuizId)) {
        if (!byParent[q.parentQuizId]) byParent[q.parentQuizId] = [];
        byParent[q.parentQuizId].push(q);
      } else if (q.quizKind === 'drill') {
        orphans.push(q);
      } else {
        mains.push(q);
      }
    }
    return { mainQuizzes: mains, childrenByParentId: byParent, standaloneDrills: orphans };
  }, [mergedQuizzes]);

  const finish = (msg: string) => {
    setNotice(msg);
    setMode({ kind: 'list' });
    void refreshDraft();
    void reloadMetaOverrides();
    window.setTimeout(() => setNotice(null), 4000);
  };

  const exportQuiz = (quiz: MyQuiz, childDrills: MyQuiz[] = []) => {
    const blob = new Blob([quizToExportJson(quiz.title, quiz.questions, childDrills)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${quiz.title.replace(/[^\w\u0600-\u06FF\- ]+/g, '').trim() || 'quiz'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startSingleQuizNow = (quiz: MyQuiz, showLawsOverride?: boolean) => {
    const readyPool = quiz.questions.filter(isExamReady);
    if (readyPool.length === 0) {
      setNotice('هذا الاختبار لا يحتوي أسئلة جاهزة للحل بعد.');
      return;
    }
    const lawsCount = readyPool.filter((qq) => Array.isArray(qq.laws) && qq.laws.length > 0).length;
    if (showLawsOverride === undefined && lawsCount > 0) {
      setPendingLawsChoice({ kind: 'quiz', quiz, lawsCount });
      return;
    }
    const settings: ExamSettings = {
      sourceMode: 'single',
      mixMode: 'total',
      quizIds: [quiz.id],
      quizTitles: [quiz.title],
      questionCount: readyPool.length,
      shuffleQuestions: false,
      shuffleChoices: false,
      showLaws: Boolean(showLawsOverride),
      timing: 'none',
      seconds: 0,
    };
    const qs = buildExam([quiz], settings);
    if (qs.length === 0) return;
    void deleteSessionSnapshot('exam_session');
    setDrillModalTarget(null);
    setPendingLawsChoice(null);
    setMode({ kind: 'examRun', settings, questions: qs });
  };

  const getLatestScoreForQuiz = (quizId: string): QuizAttempt | null => {
    for (const a of attempts) {
      if (a.settings?.quizIds?.length === 1 && a.settings.quizIds[0] === quizId) {
        return a;
      }
    }
    return null;
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
        quizzes={mergedQuizzes}
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
        onFinish={(answers, durationSec, tableAnswers) =>
          setMode({
            kind: 'examResult',
            attemptId: newAttemptId(),
            settings: mode.settings,
            questions: mode.questions,
            answers,
            tableAnswers,
            durationSec,
            finishedAt: Date.now(),
          })
        }
      />
    );
  }

  if (mode.kind === 'examResult') {
    return (
      <>
        <ExamResult
          key={mode.attemptId}
          ownerId={profile.uid}
          attemptId={mode.attemptId}
          settings={mode.settings}
          questions={mode.questions}
          answers={mode.answers}
          tableAnswers={mode.tableAnswers}
          durationSec={mode.durationSec}
          finishedAt={mode.finishedAt}
          onBack={() => {
            setMode({ kind: 'list' });
            void refreshDraft();
          }}
          onRetake={() => setMode({ kind: 'examSetup' })}
          onCreateDrill={(exQ) =>
            setDrillModalTarget({
              question: { ...exQ, answer: exQ.choices?.[exQ.correctIndex] || '' },
              sourceTitle: exQ.sourceTitle,
              sourceQuizId: exQ.sourceQuizId,
            })
          }
        />
        {drillModalTarget && (
          <CreateDrillModal
            open
            ownerId={profile.uid}
            question={drillModalTarget.question}
            sourceTitle={drillModalTarget.sourceTitle}
            sourceQuizId={drillModalTarget.sourceQuizId}
            sourceStarredId={drillModalTarget.sourceStarredId}
            mainQuizzes={mainQuizzes}
            onClose={() => setDrillModalTarget(null)}
            onCreated={() => {
              void reloadMetaOverrides();
              setNotice('تم إنشاء وحفظ اختبار التقوية بنجاح تحت اختبارك الأساسي.');
            }}
            onStartQuizNow={startSingleQuizNow}
          />
        )}
      </>
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
        <ExamReview
          ownerId={profile.uid}
          questions={a.questions}
          answers={a.answers}
          tableAnswers={a.tableAnswers}
          score={a.score}
          total={a.total}
          durationSec={a.durationSec}
          onCreateDrill={(exQ) =>
            setDrillModalTarget({
              question: { ...exQ, answer: exQ.choices?.[exQ.correctIndex] || '' },
              sourceTitle: exQ.sourceTitle,
              sourceQuizId: exQ.sourceQuizId,
            })
          }
        />
        {drillModalTarget && (
          <CreateDrillModal
            open
            ownerId={profile.uid}
            question={drillModalTarget.question}
            sourceTitle={drillModalTarget.sourceTitle}
            sourceQuizId={drillModalTarget.sourceQuizId}
            sourceStarredId={drillModalTarget.sourceStarredId}
            mainQuizzes={mainQuizzes}
            onClose={() => setDrillModalTarget(null)}
            onCreated={() => {
              void reloadMetaOverrides();
              setNotice('تم إنشاء وحفظ اختبار التقوية بنجاح تحت اختبارك الأساسي.');
            }}
            onStartQuizNow={startSingleQuizNow}
          />
        )}
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
    return (
      <ImportPanel
        ownerId={profile.uid}
        onBack={() => setMode({ kind: 'list' })}
        onParsed={(title, questions, warnings) =>
          setMode({ kind: 'edit', editingId: null, title, questions, warnings })
        }
        onBundleSaved={(msg) => finish(msg)}
      />
    );
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
            {qq.laws && qq.laws.length > 0 && (
              <QuestionLawsBox laws={qq.laws} variant="review" compact />
            )}
            <MathText text={qq.text} className="text-sm font-black text-[#3C3C3C]" />
            {qq.chart && <ChartView chart={qq.chart} />}
            {qq.figure && <FigureView figure={qq.figure} />}
            {qq.questionType === 'table' && qq.table ? (
              <QuestionTableView table={qq.table} mode="preview" />
            ) : qq.choices.length > 0 ? (
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
            {(qq.explanation ||
              qq.explanationTable ||
              qq.explanationComparison ||
              qq.explanationChart ||
              qq.explanationFigure) && (
              <RichExplanationView
                explanation={qq.explanation}
                explanationTable={qq.explanationTable}
                explanationComparison={qq.explanationComparison}
                explanationChart={qq.explanationChart}
                explanationFigure={qq.explanationFigure}
              />
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

  const startStarredExam = (showLawsOverride?: boolean) => {
    const readyQuestions: ExamQuestion[] = starredItems
      .filter((st) => isExamReady(st.question))
      .map((st) => ({
        id: st.id,
        sourceQuizId: st.sourceQuizId || 'starred',
        sourceTitle: st.sourceTitle || 'الأسئلة المميزة',
        ...(st.question.questionType === 'table' || st.question.table
          ? { questionType: 'table' as const, table: st.question.table }
          : {}),
        ...(st.question.laws && st.question.laws.length > 0 ? { laws: st.question.laws } : {}),
        text: st.question.text,
        choices: st.question.choices,
        correctIndex: st.question.correctIndex,
        explanation: st.question.explanation || '',
        ...(st.question.chart ? { chart: st.question.chart } : {}),
        ...(st.question.figure ? { figure: st.question.figure } : {}),
        ...(st.question.explanationChart ? { explanationChart: st.question.explanationChart } : {}),
        ...(st.question.explanationFigure ? { explanationFigure: st.question.explanationFigure } : {}),
        ...(st.question.explanationTable ? { explanationTable: st.question.explanationTable } : {}),
        ...(st.question.explanationComparison
          ? { explanationComparison: st.question.explanationComparison }
          : {}),
      }));
    if (readyQuestions.length === 0) return;
    const lawsCount = readyQuestions.filter((qq) => Array.isArray(qq.laws) && qq.laws.length > 0).length;
    if (showLawsOverride === undefined && lawsCount > 0) {
      setPendingLawsChoice({ kind: 'starred', lawsCount });
      return;
    }
    void deleteSessionSnapshot('exam_session');
    setPendingLawsChoice(null);
    setMode({
      kind: 'examRun',
      settings: {
        sourceMode: 'single',
        mixMode: 'total',
        quizIds: ['starred'],
        quizTitles: ['الأسئلة المميزة ⭐'],
        questionCount: readyQuestions.length,
        timing: 'none',
        seconds: 0,
        shuffleQuestions: false,
        shuffleChoices: false,
        showLaws: Boolean(showLawsOverride),
      },
      questions: readyQuestions,
    });
  };

  /* ---------------- القائمة ---------------- */
  return (
    <div className="max-w-3xl mx-auto w-full flex flex-col gap-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-[#3C3C3C]">اختباراتي</h2>
          <p className="text-xs font-bold text-[#777777]">أنشئ اختباراتك بنفسك أو استوردها من JSON، وتابع أسئلتك المميزة للمراجعة.</p>
        </div>
        <div className="inline-flex rounded-2xl border-2 border-[#E5E5E5] bg-[#F7F7F7] p-1 text-xs font-black">
          <button
            type="button"
            onClick={() => setSubTab('quizzes')}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl cursor-pointer transition-colors ${
              subTab === 'quizzes'
                ? 'bg-white text-[#8938D6] shadow-xs'
                : 'text-[#777777] hover:text-[#3C3C3C]'
            }`}
          >
            <ListChecks className="w-4 h-4" />
            <span>النماذج والمحاولات</span>
          </button>
          <button
            type="button"
            onClick={() => setSubTab('starred')}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl cursor-pointer transition-colors ${
              subTab === 'starred'
                ? 'bg-[#FFF4CC] text-[#9A6B00] shadow-xs'
                : 'text-[#777777] hover:text-[#3C3C3C]'
            }`}
          >
            <Star className={`w-4 h-4 ${subTab === 'starred' ? 'fill-[#FFC800] text-[#E5A400]' : ''}`} />
            <span>أسئلة مميزة</span>
            {starredItems.length > 0 && (
              <span className="px-1.5 py-0.5 rounded-lg bg-white border border-[#FFC800] text-[10px] font-latin">
                {starredItems.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {subTab === 'starred' ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-3xl border-2 border-[#FFC800] bg-[#FFF4CC]/60 p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Star className="w-6 h-6 fill-[#FFC800] text-[#E5A400] shrink-0" />
              <div>
                <h3 className="text-sm font-black text-[#3C3C3C]">بنك الأسئلة المميزة للمراجعة</h3>
                <p className="text-[11px] font-bold text-[#8A6500]">
                  أي سؤال تضغط على نجمته أثناء الاختبار أو المراجعة يُحفظ هنا لتعود إليه وتختبر نفسك فيه في أي وقت.
                </p>
              </div>
            </div>
            {starredItems.length > 0 && (
              <button
                type="button"
                onClick={() => startStarredExam()}
                className="duo-btn flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-[#FFC800] hover:bg-[#FFD426] border-2 border-b-4 border-[#E5A400] text-[#3C3C3C] text-xs font-black cursor-pointer shrink-0"
              >
                <Play className="w-4 h-4" />
                <span>اختبر نفسي بالأسئلة المميزة ({starredItems.length})</span>
              </button>
            )}
          </div>

          {starredItems.length === 0 ? (
            <div className={`${card} p-8 text-center flex flex-col items-center gap-2 text-[#777777]`}>
              <Star className="w-8 h-8 text-[#FFC800]" />
              <p className="text-sm font-black text-[#3C3C3C]">لا توجد أسئلة مميزة بعد</p>
              <p className="text-xs font-bold max-w-md">
                أثناء دخولك لأي اختبار اضغط على أيقونة النجمة ⭐ أعلى السؤال لحفظه هنا والرجوع إليه للمراجعة.
              </p>
            </div>
          ) : (
            starredItems.map((item, idx) => {
              const qq = item.question;
              const isTable = qq.questionType === 'table' && Boolean(qq.table);
              const expShown = Boolean(revealedStarExplanations[item.id]);
              const hasExp = Boolean(
                qq.explanation ||
                  qq.explanationTable ||
                  qq.explanationComparison ||
                  qq.explanationChart ||
                  qq.explanationFigure
              );
              return (
                <div key={item.id} className={`${card} p-4 flex flex-col gap-2.5`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-1 rounded-full bg-[#FFF4CC] border border-[#FFC800] text-[#9A6B00] text-xs font-black">
                        سؤال مميز #{idx + 1}
                      </span>
                      {item.sourceTitle && (
                        <span className="text-[11px] font-bold text-[#777777]">
                          من: {item.sourceTitle}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          setDrillModalTarget({
                            question: qq,
                            sourceTitle: item.sourceTitle,
                            sourceQuizId: item.sourceQuizId,
                            sourceStarredId: item.id,
                          })
                        }
                        className="duo-btn flex items-center gap-1.5 px-3 py-1 rounded-xl bg-[#A560E8] hover:bg-[#B477EE] border border-b-2 border-[#8938D6] text-white text-[11px] font-black cursor-pointer"
                      >
                        <Dumbbell className="w-3.5 h-3.5" />
                        <span>اعمل اختبار تقوية على هذه المسألة</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeStarredQuestion(profile.uid, item.id)}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-xl bg-white border border-[#E5E5E5] hover:border-[#FF4B4B] text-[11px] font-black text-[#EA2B2B] cursor-pointer"
                      >
                        <Star className="w-3.5 h-3.5 fill-[#FFC800] text-[#E5A400]" />
                        <span>إزالة النجمة</span>
                      </button>
                    </div>
                  </div>

                  {qq.laws && qq.laws.length > 0 && (
                    <QuestionLawsBox laws={qq.laws} variant="review" compact />
                  )}
                  <MathText text={qq.text} className="text-sm font-black text-[#3C3C3C] leading-relaxed" />
                  {qq.chart && <ChartView chart={qq.chart} />}
                  {qq.figure && <FigureView figure={qq.figure} />}

                  {isTable && qq.table ? (
                    <QuestionTableView table={qq.table} mode="preview" />
                  ) : qq.choices.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      {qq.choices.map((c, ci) => (
                        <div
                          key={ci}
                          className={`flex items-center gap-2 px-3 py-2 rounded-2xl border-2 text-sm font-bold ${
                            ci === qq.correctIndex
                              ? 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                              : 'bg-white border-[#E5E5E5] text-[#3C3C3C]'
                          }`}
                        >
                          {ci === qq.correctIndex && <CheckCircle2 className="w-4 h-4 shrink-0" />}
                          <MathText text={c} />
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {hasExp && (
                    <div className="flex flex-col gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setRevealedStarExplanations((prev) => ({
                            ...prev,
                            [item.id]: !prev[item.id],
                          }))
                        }
                        className="self-start flex items-center gap-1.5 text-xs font-black text-[#1899D6] cursor-pointer"
                      >
                        {expShown ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        <span>{expShown ? 'إخفاء شرح الحل' : 'عرض شرح الحل المفصل'}</span>
                      </button>
                      {expShown && (
                        <RichExplanationView
                          explanation={qq.explanation}
                          explanationTable={qq.explanationTable}
                          explanationComparison={qq.explanationComparison}
                          explanationChart={qq.explanationChart}
                          explanationFigure={qq.explanationFigure}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      ) : (
        <>

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
              : `لديك اختبار غير مكتمل (${
                  session.questions.filter((qq, i) =>
                    isQuestionAnswered(qq, i, session.answers, session.tableAnswers)
                  ).length
                } من ${session.questions.length} مُجاب) — تابع من حيث توقفت.`}
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
                      tableAnswers: session.tableAnswers,
                      durationSec: Math.round(session.elapsedMs / 1000),
                      finishedAt: session.updatedAt,
                    })
                  : setMode({
                      kind: 'examRun',
                      settings: session.settings,
                      questions: session.questions,
                      initial: {
                        answers: session.answers,
                        tableAnswers: session.tableAnswers,
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
      ) : mergedQuizzes.length === 0 ? (
        <div className={`${card} p-8 text-center text-sm font-bold text-[#777777]`}>
          لا توجد اختبارات بعد. ابدأ بإنشاء اختبار أو استيراده.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {mainQuizzes.map((q) => {
            const children = childrenByParentId[q.id] ?? [];
            const lastAttempt = getLatestScoreForQuiz(q.id);
            const lastPct =
              lastAttempt && lastAttempt.total > 0
                ? Math.round((lastAttempt.score / lastAttempt.total) * 100)
                : null;

            return (
              <div key={q.id} className="flex flex-col gap-2.5">
                {/* Main Quiz Card */}
                <div className={`${card} p-4 flex flex-col gap-3`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-black text-[#3C3C3C] truncate">{q.title}</h3>
                        {children.length > 0 && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-[#F5ECFF] border border-[#A560E8]/60 text-[10px] font-black text-[#8938D6]">
                            <Layers className="w-3 h-3" />
                            <span>{children.length} تقوية / قاعدة</span>
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] font-extrabold text-[#777777] mt-0.5">
                        {q.questionCount} سؤال · آخر تعديل {formatTimestamp(q.updatedAt)}
                      </p>
                    </div>
                    {lastAttempt && lastPct !== null && (
                      <span
                        dir="ltr"
                        className={`px-2.5 py-1 rounded-xl border text-xs font-black font-latin shrink-0 ${
                          lastPct >= 85
                            ? 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                            : lastPct >= 50
                            ? 'bg-[#FFF4CC] border-[#FFC800] text-[#8A6500]'
                            : 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B]'
                        }`}
                      >
                        {lastAttempt.score}/{lastAttempt.total} ({lastPct}%)
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => startSingleQuizNow(q)}
                      className="duo-btn flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-xs font-black text-white cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5" /> ابدأ
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode({ kind: 'view', quiz: q })}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#DDF4FF] border-2 border-[#1CB0F6] text-xs font-black text-[#1899D6] cursor-pointer"
                    >
                      <FolderOpen className="w-3.5 h-3.5" /> فتح
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setMode({
                          kind: 'edit',
                          editingId: q.id,
                          title: q.title,
                          questions: q.questions.map((x) => JSON.parse(JSON.stringify(x)) as QuizQuestion),
                          warnings: [],
                        })
                      }
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer"
                    >
                      <Pencil className="w-3.5 h-3.5" /> تعديل
                    </button>
                    <button
                      type="button"
                      onClick={() => exportQuiz(q, children)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer"
                      title={
                        children.length > 0
                          ? 'تصدير الاختبار الأساسي مع جميع اختبارات التقوية التابعة له في ملف JSON واحد'
                          : 'تصدير الاختبار بصيغة JSON'
                      }
                    >
                      <Download className="w-3.5 h-3.5" />{' '}
                      {children.length > 0 ? `تصدير الحزمة (${1 + children.length})` : 'تصدير JSON'}
                    </button>
                    {confirmDeleteId === q.id ? (
                      <span className="flex items-center gap-2 text-xs font-black">
                        <button
                          type="button"
                          disabled={deleting}
                          onClick={() => void confirmDelete(q.id)}
                          className="px-3 py-1.5 rounded-xl bg-[#FF4B4B] text-white cursor-pointer"
                        >
                          {deleting ? '...' : 'تأكيد الحذف'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="text-[#777777] cursor-pointer"
                        >
                          إلغاء
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(q.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#EA2B2B] cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> حذف
                      </button>
                    )}
                  </div>
                </div>

                {/* Nested Duolingo-style Reinforcement & Rule-Training Skill Tree */}
                {children.length > 0 && (
                  <div className="mr-3 sm:mr-5 pr-3 sm:pr-4 border-r-4 border-[#A560E8]/45 flex flex-col gap-2">
                    <div className="flex items-center gap-1.5 text-[11px] font-black text-[#8938D6]">
                      <Dumbbell className="w-3.5 h-3.5" />
                      <span>تمارين التقوية وتدريبات القواعد التابعة ({children.length})</span>
                    </div>
                    {children.map((child, cIdx) => {
                      const cAttempt = getLatestScoreForQuiz(child.id);
                      const cPct =
                        cAttempt && cAttempt.total > 0
                          ? Math.round((cAttempt.score / cAttempt.total) * 100)
                          : null;
                      const styleLabel =
                        child.drillStyle === 'same_values'
                          ? 'تغيير قيم'
                          : child.drillStyle === 'same_law_ideas'
                          ? 'أفكار مختلفة'
                          : 'متنوع';

                      return (
                        <div
                          key={child.id}
                          className="rounded-2xl border-2 border-b-4 border-[#E2D4F8] bg-gradient-to-l from-[#FAF7FF] to-white p-3.5 flex flex-col gap-2.5"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="flex items-start gap-2.5 min-w-0 flex-1">
                              <div className="w-8 h-8 rounded-xl bg-[#A560E8] border-b-2 border-[#8938D6] text-white flex items-center justify-center font-latin font-black text-xs shrink-0">
                                {cIdx + 1}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <h4 className="text-sm font-black text-[#3C3C3C] truncate">
                                    {child.title}
                                  </h4>
                                  <span className="px-2 py-0.5 rounded-lg bg-[#F3E8FF] border border-[#A560E8]/50 text-[10px] font-black text-[#8938D6]">
                                    {child.ruleTitle || styleLabel}
                                  </span>
                                </div>
                                <p className="text-[11px] font-bold text-[#777777]">
                                  {child.questionCount} سؤال · تقوية تابعة
                                </p>
                              </div>
                            </div>

                            {cAttempt && cPct !== null && (
                              <span
                                dir="ltr"
                                className={`px-2 py-0.5 rounded-lg border text-[11px] font-black font-latin shrink-0 ${
                                  cPct >= 85
                                    ? 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                                    : cPct >= 50
                                    ? 'bg-[#FFF4CC] border-[#FFC800] text-[#8A6500]'
                                    : 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B]'
                                }`}
                              >
                                {cAttempt.score}/{cAttempt.total} ({cPct}%)
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => startSingleQuizNow(child)}
                              className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#A560E8] hover:bg-[#B477EE] border-2 border-b-4 border-[#8938D6] text-white text-[11px] font-black cursor-pointer"
                            >
                              <Play className="w-3.5 h-3.5" /> ابدأ التدريب
                            </button>
                            <button
                              type="button"
                              onClick={() => setMode({ kind: 'view', quiz: child })}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-[#DDF4FF] border border-[#1CB0F6] text-[11px] font-black text-[#1899D6] cursor-pointer"
                            >
                              <FolderOpen className="w-3.5 h-3.5" /> فتح
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setMode({
                                  kind: 'edit',
                                  editingId: child.id,
                                  title: child.title,
                                  questions: child.questions.map(
                                    (x) => JSON.parse(JSON.stringify(x)) as QuizQuestion
                                  ),
                                  warnings: [],
                                })
                              }
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-white border border-[#E5E5E5] text-[11px] font-black text-[#3C3C3C] cursor-pointer"
                            >
                              <Pencil className="w-3.5 h-3.5" /> تعديل
                            </button>
                            <button
                              type="button"
                              onClick={() => exportQuiz(child)}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-white border border-[#E5E5E5] text-[11px] font-black text-[#3C3C3C] cursor-pointer"
                            >
                              <Download className="w-3.5 h-3.5" /> تصدير
                            </button>
                            {confirmDeleteId === child.id ? (
                              <span className="flex items-center gap-1.5 text-[11px] font-black">
                                <button
                                  type="button"
                                  disabled={deleting}
                                  onClick={() => void confirmDelete(child.id)}
                                  className="px-2.5 py-1 rounded-xl bg-[#FF4B4B] text-white cursor-pointer"
                                >
                                  {deleting ? '...' : 'تأكيد'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="text-[#777777] cursor-pointer"
                                >
                                  إلغاء
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(child.id)}
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-white border border-[#E5E5E5] text-[11px] font-black text-[#EA2B2B] cursor-pointer"
                              >
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
          })}

          {standaloneDrills.length > 0 && (
            <div className="flex flex-col gap-2.5 pt-2 border-t-2 border-[#EFE6FF]">
              <h3 className="flex items-center gap-1.5 text-sm font-black text-[#8938D6]">
                <Dumbbell className="w-4 h-4" />
                <span>اختبارات تقوية عامة ({standaloneDrills.length})</span>
              </h3>
              {standaloneDrills.map((drill) => {
                const dAttempt = getLatestScoreForQuiz(drill.id);
                const dPct =
                  dAttempt && dAttempt.total > 0
                    ? Math.round((dAttempt.score / dAttempt.total) * 100)
                    : null;
                return (
                  <div
                    key={drill.id}
                    className="rounded-3xl border-2 border-b-4 border-[#E2D4F8] bg-gradient-to-l from-[#FAF7FF] to-white p-4 flex flex-col gap-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h4 className="text-sm sm:text-base font-black text-[#3C3C3C] truncate">
                          {drill.title}
                        </h4>
                        <p className="text-[11px] font-bold text-[#777777]">
                          {drill.questionCount} سؤال · تقوية مستقلة
                        </p>
                      </div>
                      {dAttempt && dPct !== null && (
                        <span
                          dir="ltr"
                          className={`px-2 py-0.5 rounded-lg border text-xs font-black font-latin shrink-0 ${
                            dPct >= 85
                              ? 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                              : dPct >= 50
                              ? 'bg-[#FFF4CC] border-[#FFC800] text-[#8A6500]'
                              : 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B]'
                          }`}
                        >
                          {dAttempt.score}/{dAttempt.total} ({dPct}%)
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => startSingleQuizNow(drill)}
                        className="duo-btn flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[#A560E8] border-2 border-b-4 border-[#8938D6] text-xs font-black text-white cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5" /> ابدأ التدريب
                      </button>
                      <button
                        type="button"
                        onClick={() => setMode({ kind: 'view', quiz: drill })}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#DDF4FF] border-2 border-[#1CB0F6] text-xs font-black text-[#1899D6] cursor-pointer"
                      >
                        <FolderOpen className="w-3.5 h-3.5" /> فتح
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setMode({
                            kind: 'edit',
                            editingId: drill.id,
                            title: drill.title,
                            questions: drill.questions.map(
                              (x) => JSON.parse(JSON.stringify(x)) as QuizQuestion
                            ),
                            warnings: [],
                          })
                        }
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer"
                      >
                        <Pencil className="w-3.5 h-3.5" /> تعديل
                      </button>
                      <button
                        type="button"
                        onClick={() => exportQuiz(drill)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" /> تصدير JSON
                      </button>
                      {confirmDeleteId === drill.id ? (
                        <span className="flex items-center gap-2 text-xs font-black">
                          <button
                            type="button"
                            disabled={deleting}
                            onClick={() => void confirmDelete(drill.id)}
                            className="px-3 py-1.5 rounded-xl bg-[#FF4B4B] text-white cursor-pointer"
                          >
                            {deleting ? '...' : 'تأكيد الحذف'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="text-[#777777] cursor-pointer"
                          >
                            إلغاء
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(drill.id)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#EA2B2B] cursor-pointer"
                        >
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
        </>
      )}

      {drillModalTarget && (
        <CreateDrillModal
          open
          ownerId={profile.uid}
          question={drillModalTarget.question}
          sourceTitle={drillModalTarget.sourceTitle}
          sourceQuizId={drillModalTarget.sourceQuizId}
          sourceStarredId={drillModalTarget.sourceStarredId}
          mainQuizzes={mainQuizzes}
          onClose={() => setDrillModalTarget(null)}
          onCreated={(items) => {
            void reloadMetaOverrides();
            setSubTab('quizzes');
            setNotice(
              items.length === 1
                ? `تم إنشاء اختبار التقوية «${items[0].title}» تحت الاختبار الأساسي!`
                : `تم إنشاء ${items.length} اختبارات تقوية بنجاح!`
            );
          }}
          onStartQuizNow={startSingleQuizNow}
        />
      )}

      {pendingLawsChoice && (
        <div
          className="fixed inset-0 z-50 bg-black/55 backdrop-blur-xs flex items-center justify-center p-4"
          dir="rtl"
        >
          <div className="duo-card max-w-md w-full bg-white border-2 border-[#84D8FF] p-5 flex flex-col gap-3">
            <div className="flex items-center gap-2.5">
              <div className="w-10 h-10 rounded-2xl bg-[#1CB0F6] border-b-4 border-[#1899D6] text-white flex items-center justify-center shrink-0">
                <BookOpen className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-black text-[#3C3C3C]">
                  هل تريد إظهار القوانين أثناء الاختبار؟
                </h3>
                <p className="text-[11px] font-bold text-[#777777]">
                  يحتوي هذا الاختبار على قوانين في <span className="font-latin">{pendingLawsChoice.lawsCount}</span> سؤالاً (تظهر القوانين فقط فوق السؤال دون الحل).
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  const choice = pendingLawsChoice;
                  setPendingLawsChoice(null);
                  if (choice.kind === 'quiz') startSingleQuizNow(choice.quiz, true);
                  else startStarredExam(true);
                }}
                className="duo-btn flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-b-4 border-[#1899D6] text-white text-sm font-black cursor-pointer"
              >
                <BookOpen className="w-4 h-4" />
                <span>نعم، ابدأ مع إظهار القوانين فوق السؤال</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const choice = pendingLawsChoice;
                  setPendingLawsChoice(null);
                  if (choice.kind === 'quiz') startSingleQuizNow(choice.quiz, false);
                  else startStarredExam(false);
                }}
                className="duo-btn flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl bg-[#A560E8] hover:bg-[#B477EE] border-2 border-b-4 border-[#8938D6] text-white text-sm font-black cursor-pointer"
              >
                <Play className="w-4 h-4" />
                <span>لا، ابدأ بدون قوانين (اختبار قياسي)</span>
              </button>
              <button
                type="button"
                onClick={() => setPendingLawsChoice(null)}
                className="px-4 py-2 rounded-xl text-xs font-black text-[#777777] hover:bg-[#F7F7F7] cursor-pointer"
              >
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* ===================== لوحة الاستيراد ===================== */

const ImportPanel: React.FC<{
  ownerId: string;
  onBack: () => void;
  onParsed: (title: string, questions: QuizQuestion[], warnings: string[]) => void;
  onBundleSaved: (message: string) => void;
}> = ({ ownerId, onBack, onParsed, onBundleSaved }) => {
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [includeRuleDrills, setIncludeRuleDrills] = useState(false);
  const [drillQuestionsPerRule, setDrillQuestionsPerRule] = useState(5);
  const [drillStyle, setDrillStyle] = useState<DrillStyle>('mixed');
  const [bundlePreview, setBundlePreview] = useState<ParsedQuizBundle | null>(null);
  const [savingBundle, setSavingBundle] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const activePrompt = useMemo(
    () =>
      buildMainImportPrompt({
        includeRuleDrills,
        drillQuestionsPerRule,
        drillStyle,
      }),
    [includeRuleDrills, drillQuestionsPerRule, drillStyle]
  );

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(activePrompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setShowPrompt(true);
    }
  };

  const read = () => {
    setError(null);
    try {
      const res = parseQuizBundleJson(raw);
      if (res.subQuizzes.length > 0) {
        setBundlePreview(res);
      } else {
        onParsed(res.title, res.questions, res.warnings);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر قراءة الملف.');
    }
  };

  const saveBundleAll = async () => {
    if (!bundlePreview) return;
    setSavingBundle(true);
    setError(null);
    try {
      const mainTitle = bundlePreview.title || 'اختبار أساسي مستورد';
      const mainChunks = await createMyQuizzesAutoSplit(ownerId, mainTitle, bundlePreview.questions, {
        quizKind: 'main',
      });
      const mainId = mainChunks[0]?.id;
      let totalSubSaved = 0;
      for (const sub of bundlePreview.subQuizzes) {
        const subChunks = await createMyQuizzesAutoSplit(ownerId, sub.title, sub.questions, {
          ...(mainId ? { parentQuizId: mainId } : {}),
          quizKind: 'drill',
          drillStyle: sub.drillStyle || 'mixed',
          ...(sub.ruleTitle ? { ruleTitle: sub.ruleTitle } : {}),
        });
        totalSubSaved += subChunks.length;
      }
      onBundleSaved(
        `تم حفظ الاختبار الأساسي «${mainTitle}» (${bundlePreview.questions.length} سؤالاً) ومعه ${totalSubSaved} اختبارات تدريب وتقوية منفصلة للقواعد تحته!`
      );
    } catch (e) {
      setError(formatQuizSaveError(e));
    } finally {
      setSavingBundle(false);
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 15_000_000) {
      setError('الملف كبير جداً (الحد 15MB).');
      return;
    }
    setRaw(await f.text());
    setBundlePreview(null);
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
          الصق السكريبت في أي ذكاء اصطناعي (ChatGPT / Claude / Gemini) ثم أضف تحته مادتك أو أسئلتك. يمكنك أيضاً تفعيل إنشاء اختبارات تقوية منفصلة لكل قاعدة تحت الاختبار الأساسي.
        </p>

        {/* Option: Include separate rule-drill subQuizzes */}
        <div className="p-3 rounded-2xl bg-[#FAF7FF] border-2 border-[#E2D4F8] flex flex-col gap-2.5">
          <div className="text-xs font-black text-[#5C1A99] flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-[#8938D6]" />
            <span>هل تطلب من الـ AI إنشاء اختبارات تقوية منفصلة لكل قاعدة تحت الاختبار الأساسي؟</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setIncludeRuleDrills(false)}
              className={`px-3 py-2 rounded-xl border-2 text-xs font-black cursor-pointer text-right ${
                !includeRuleDrills
                  ? 'bg-[#E6F7FF] border-[#1CB0F6] text-[#1899D6]'
                  : 'bg-white border-[#E5E5E5] text-[#555]'
              }`}
            >
              لا، الاختبار الأساسي فقط
            </button>
            <button
              type="button"
              onClick={() => setIncludeRuleDrills(true)}
              className={`px-3 py-2 rounded-xl border-2 text-xs font-black cursor-pointer text-right ${
                includeRuleDrills
                  ? 'bg-[#F3E8FF] border-[#A560E8] text-[#8938D6]'
                  : 'bg-white border-[#E5E5E5] text-[#555]'
              }`}
            >
              نعم، اختبار أساسي + تدريبات منفصلة لكل قاعدة
            </button>
          </div>

          {includeRuleDrills && (
            <div className="flex flex-wrap items-center gap-3 pt-1 text-xs font-bold text-[#3C3C3C]">
              <div className="flex items-center gap-1.5">
                <span>أسئلة لكل قاعدة:</span>
                {[5, 8, 10, 15].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setDrillQuestionsPerRule(n)}
                    className={`px-2.5 py-1 rounded-lg border text-[11px] font-black font-latin cursor-pointer ${
                      drillQuestionsPerRule === n
                        ? 'bg-[#A560E8] border-[#8938D6] text-white'
                        : 'bg-white border-[#E5E5E5]'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <span>أسلوب التدريب:</span>
                <select
                  value={drillStyle}
                  onChange={(e) => setDrillStyle(e.target.value as DrillStyle)}
                  className="px-2.5 py-1 rounded-lg border border-[#E5E5E5] bg-white text-[11px] font-black outline-none"
                >
                  <option value="mixed">متنوع وشامل</option>
                  <option value="same_law_ideas">نفس القانون بأفكار مختلفة</option>
                  <option value="same_values">نفس القالب بتغيير القيم</option>
                </select>
              </div>
            </div>
          )}
        </div>

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
            {activePrompt}
          </pre>
        )}
      </div>

      <div className={`${card} p-4 flex flex-col gap-2`}>
        <h3 className="text-sm font-black text-[#3C3C3C]">كيف تُضاف الجداول التفاعلية والأشكال الهندسية والرسوم والشرح التفصيلي؟</h3>
        <ul className="text-xs font-bold text-[#555] leading-relaxed list-disc pr-5 flex flex-col gap-1">
          <li>أسئلة الاختيارات: تحتوي <span className="font-latin">choices</span> و<span className="font-latin">correctIndex</span> (يبدأ من 0).</li>
          <li>أسئلة الجداول التفاعلية: تُضاف بصيغة <span className="font-latin">{'"questionType": "table"'}</span> وحقل <span className="font-latin">table</span> لتحديد الخلايا الثابتة والفراغات التفاعلية (<span className="font-latin">number</span> أو <span className="font-latin">text</span> مع تلميح مثل <span className="font-latin">س / أ</span>).</li>
          <li>قوانين المسألة (<span className="font-latin">laws</span>): مصفوفة نصوص تحتوي قانوناً أو أكثر بصيغة عامة دون كشف الحل، ويمكن إظهارها فوق السؤال عند بدء الاختبار.</li>
          <li>الأشكال الهندسية والرسوم البيانية: يُضاف <span className="font-latin">figure</span> للهندسة أو <span className="font-latin">chart</span> (<span className="font-latin">bar / hbar / line / pie</span>) للرسوم البيانية.</li>
          <li>الحزمة المتكاملة (<span className="font-latin">subQuizzes</span>): إذا أضافها السكريبت أو نزّلتها من اختبار سابق، تُحفظ جميع تدريبات القواعد تلقائياً تحت الاختبار الأساسي.</li>
        </ul>
        <button
          type="button"
          onClick={() => {
            setRaw(EXAMPLE_JSON);
            setBundlePreview(null);
            setError(null);
          }}
          className="self-start text-xs font-black text-[#7C3AED] hover:underline cursor-pointer"
        >
          تجربة مثال قدرات شامل (جدول تفاعلي + هندسة مركبة + أعمدة + دائري + مقارنة وشرح مفصل)
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
            setBundlePreview(null);
            setError(null);
          }}
          placeholder={'{ "title": "...", "questions": [ ... ], "subQuizzes": [ ... ] }'}
          className="w-full rounded-2xl border-2 border-[#E5E5E5] focus:border-[#1CB0F6] outline-none p-3 text-xs font-latin leading-relaxed bg-[#F7F7F7]"
        />
        <input ref={fileRef} type="file" accept=".json,application/json,text/plain" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
        {error && (
          <div className="p-3 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-xs font-extrabold text-[#EA2B2B]">{error}</div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={read} disabled={!raw.trim()} className="duo-btn flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#58CC02] border-2 border-[#46A302] border-b-4 text-white text-sm font-black cursor-pointer disabled:opacity-50">
            قراءة ومعاينة الأسئلة
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-white border-2 border-[#E5E5E5] border-b-4 text-sm font-black text-[#3C3C3C] cursor-pointer">
            <Upload className="w-4 h-4" /> رفع ملف
          </button>
        </div>
      </div>

      {/* Bundle Preview when subQuizzes are present */}
      {bundlePreview && (
        <div className="rounded-3xl border-2 border-b-4 border-[#A560E8] bg-[#FAF7FF] p-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-black text-[#3C3C3C]">
                تم اكتشاف حزمة متكاملة: الأساسي + {bundlePreview.subQuizzes.length} اختبارات تقوية!
              </h3>
              <p className="text-xs font-bold text-[#777777]">
                سيُحفظ الاختبار الأساسي أولاً، ثم تُربط جميع اختبارات القواعد والتقوية تحته مباشرة.
              </p>
            </div>
          </div>

          <div className="p-3 rounded-2xl bg-white border-2 border-[#58CC02] flex items-center justify-between gap-2">
            <span className="text-sm font-black text-[#3C3C3C]">
              الأساسي: {bundlePreview.title || 'اختبار أساسي'}
            </span>
            <span className="px-2.5 py-0.5 rounded-lg bg-[#D7FFB8] text-[#46A302] text-xs font-black">
              {bundlePreview.questions.length} سؤال
            </span>
          </div>

          <div className="mr-4 pr-3 border-r-4 border-[#A560E8]/45 flex flex-col gap-2">
            {bundlePreview.subQuizzes.map((sq, idx) => (
              <div
                key={idx}
                className="p-2.5 rounded-2xl bg-white border border-[#E2D4F8] flex items-center justify-between gap-2 text-xs font-bold"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-6 h-6 rounded-lg bg-[#A560E8] text-white flex items-center justify-center font-latin font-black shrink-0">
                    {idx + 1}
                  </span>
                  <span className="font-black text-[#3C3C3C] truncate">{sq.title}</span>
                  {sq.ruleTitle && (
                    <span className="px-2 py-0.5 rounded-lg bg-[#F3E8FF] text-[#8938D6] text-[10px] font-black">
                      {sq.ruleTitle}
                    </span>
                  )}
                </div>
                <span className="text-[#8938D6] font-black shrink-0">{sq.questions.length} سؤال</span>
              </div>
            ))}
          </div>

          {bundlePreview.warnings.length > 0 && (
            <div className="p-2.5 rounded-xl bg-[#FFF4CC] border border-[#FFC800] text-[11px] font-bold text-[#8A6500]">
              ملاحظات ({bundlePreview.warnings.length}): {bundlePreview.warnings.slice(0, 3).join(' · ')}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={savingBundle}
              onClick={() => void saveBundleAll()}
              className="duo-btn flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-sm font-black cursor-pointer disabled:opacity-50"
            >
              {savingBundle ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              <span>
                {savingBundle
                  ? 'جاري حفظ الحزمة بالكامل...'
                  : `حفظ الأساسي + (${bundlePreview.subQuizzes.length}) اختبارات قواعد دفعة واحدة`}
              </span>
            </button>
            <button
              type="button"
              disabled={savingBundle}
              onClick={() =>
                onParsed(bundlePreview.title, bundlePreview.questions, bundlePreview.warnings)
              }
              className="px-4 py-2.5 rounded-2xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer"
            >
              مراجعة الاختبار الأساسي فقط في المحرر
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
