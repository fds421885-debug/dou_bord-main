import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Eye,
  EyeOff,
  ListChecks,
  Loader2,
  PlusCircle,
  Save,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import type { QuizQuestion } from '../types';
import { MathText } from '../mathText';
import { applySnippet, MathToolbar } from './MathToolbar';
import { QuizChartEditor } from './QuizChartEditor';
import { QuizFigureEditor } from './QuizFigureEditor';
import { QuestionTableView, QuizTableEditor } from './QuestionTableView';
import { RichExplanationView } from './RichExplanationView';
import { createDefaultTableQuestion } from '../quizTable';
import { DuoLoading } from './DuoLoading';
import {
  cleanQuestions,
  createMyQuizzesAutoSplit,
  emptyQuestion,
  formatQuizSaveError,
  LIMITS,
  newQuestionId,
  updateMyQuiz,
  validateForSave,
} from '../myQuizzes';
import { deleteSessionSnapshot, saveSessionSnapshot } from '../localDraftStore';

interface Props {
  ownerId: string;
  editingId: string | null;
  initialTitle: string;
  initialQuestions: QuizQuestion[];
  warnings?: string[];
  onDone: (message: string) => void;
  onCancel: () => void;
}

type Setter = (next: string) => void;
interface ActiveField {
  el: HTMLInputElement | HTMLTextAreaElement;
  set: Setter;
}

interface FieldProps {
  value: string;
  onChange: Setter;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  maxLength?: number;
  onFocusField: (f: ActiveField) => void;
  className?: string;
}

const fieldCls =
  'w-full rounded-2xl border-2 border-[#E5E5E5] focus:border-[#1CB0F6] outline-none px-3 py-2 text-sm font-bold text-[#3C3C3C] bg-white';

const MathField: React.FC<FieldProps> = ({
  value,
  onChange,
  multiline,
  rows = 3,
  placeholder,
  maxLength,
  onFocusField,
  className,
}) => {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const register = () => {
    if (ref.current) onFocusField({ el: ref.current, set: onChange });
  };
  const common = {
    ref,
    value,
    placeholder,
    maxLength,
    onFocus: register,
    onClick: register,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
    className: `${fieldCls} ${className ?? ''}`,
    dir: 'auto' as const,
  };
  return multiline ? <textarea {...common} rows={rows} /> : <input {...common} type="text" />;
};

export const QuizEditor: React.FC<Props> = ({
  ownerId,
  editingId,
  initialTitle,
  initialQuestions,
  warnings = [],
  onDone,
  onCancel,
}) => {
  const [title, setTitle] = useState(initialTitle);
  const [questions, setQuestions] = useState<QuizQuestion[]>(() =>
    initialQuestions.length
      ? initialQuestions.map((q) => {
          if (q.questionType === 'table' || (q.table && q.choices.length === 0)) {
            return {
              ...q,
              questionType: 'table',
              table: q.table ?? createDefaultTableQuestion(),
              choices: [],
              correctIndex: -1,
            };
          }
          if (q.choices.length >= 2) return q;
          const choices = [...q.choices];
          while (choices.length < 4) choices.push('');
          return { ...q, choices, correctIndex: -1 };
        })
      : [emptyQuestion()]
  );
  const [showPreview, setShowPreview] = useState(true);
  const [page, setPage] = useState(0);
  const [showAllQuestions, setShowAllQuestions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const activeRef = useRef<ActiveField | null>(null);
  const [hasActive, setHasActive] = useState(false);

  const PAGE_SIZE = 50;
  const totalPages = Math.max(1, Math.ceil(questions.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const isPaginated = questions.length > PAGE_SIZE && !showAllQuestions;
  const startIdx = isPaginated ? safePage * PAGE_SIZE : 0;
  const visibleQuestions = isPaginated
    ? questions.slice(startIdx, startIdx + PAGE_SIZE)
    : questions;

  // حفظ تلقائي محلي للمسودة (يُستكمل بعد إغلاق الصفحة أو انقطاع الإنترنت)
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      void saveSessionSnapshot({
        key: 'my_quiz_draft',
        ownerId,
        editingId,
        title,
        questions,
        updatedAt: Date.now(),
      });
    }, 600);
    return () => window.clearTimeout(t);
  }, [title, questions, ownerId, editingId]);

  // حفظ فوري للمسودة عند أول فتح (للاستيراد)
  useEffect(() => {
    if (initialQuestions.length === 0) return;
    void saveSessionSnapshot({
      key: 'my_quiz_draft',
      ownerId,
      editingId,
      title: initialTitle,
      questions: initialQuestions,
      updatedAt: Date.now(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFocusField = useCallback((f: ActiveField) => {
    activeRef.current = f;
    setHasActive(true);
  }, []);

  const insertSnippet = (tex: string) => {
    const f = activeRef.current;
    if (!f || !document.body.contains(f.el)) return;
    const start = f.el.selectionStart ?? f.el.value.length;
    const end = f.el.selectionEnd ?? start;
    const res = applySnippet(f.el.value, start, end, tex);
    f.set(res.value);
    requestAnimationFrame(() => {
      try {
        f.el.focus();
        f.el.setSelectionRange(res.caret, res.caret);
      } catch {
        /* ignore */
      }
    });
  };

  const patch = (id: string, p: Partial<QuizQuestion>) =>
    setQuestions((qs) => qs.map((q) => (q.id === id ? { ...q, ...p } : q)));

  const move = (idx: number, dir: -1 | 1) =>
    setQuestions((qs) => {
      const j = idx + dir;
      if (j < 0 || j >= qs.length) return qs;
      const next = qs.slice();
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });

  const duplicate = (idx: number) =>
    setQuestions((qs) => {
      if (qs.length >= LIMITS.maxQuestions) return qs;
      const cloned = JSON.parse(JSON.stringify(qs[idx])) as QuizQuestion;
      const copy: QuizQuestion = { ...cloned, id: newQuestionId(), choices: cloned.choices.slice() };
      const next = qs.slice();
      next.splice(idx + 1, 0, copy);
      return next;
    });

  const remove = (id: string) =>
    setQuestions((qs) => (qs.length <= 1 ? [emptyQuestion()] : qs.filter((q) => q.id !== id)));

  const addQuestion = (kind: 'mcq' | 'table' = 'mcq') => {
    setQuestions((qs) => {
      if (qs.length >= LIMITS.maxQuestions) return qs;
      const next = [...qs, emptyQuestion(kind)];
      if (next.length > PAGE_SIZE) {
        setPage(Math.ceil(next.length / PAGE_SIZE) - 1);
      }
      return next;
    });
  };

  const filled = useMemo(() => cleanQuestions(questions).length, [questions]);

  const handleSave = async () => {
    const problem = validateForSave(title, questions, { allowAutoSplit: !editingId });
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await updateMyQuiz(ownerId, editingId, title, questions);
        await deleteSessionSnapshot('my_quiz_draft');
        onDone('تم حفظ التعديلات.');
      } else {
        const chunks = await createMyQuizzesAutoSplit(ownerId, title, questions);
        await deleteSessionSnapshot('my_quiz_draft');
        if (chunks.length > 1) {
          const totalQ = chunks.reduce((acc, c) => acc + c.questions.length, 0);
          onDone(`تمت إضافة الاختبار كاملاً (${totalQ} سؤالاً) مقسماً تلقائياً على ${chunks.length} أجزاء لتجاوز حد حجم المستند.`);
        } else {
          onDone(`تمت إضافة الاختبار (${filled} سؤالاً) إلى اختباراتي.`);
        }
      }
    } catch (e) {
      setError(formatQuizSaveError(e));
    } finally {
      setSaving(false);
    }
  };

  const copyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId(null), 1200);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="flex flex-col gap-4" dir="rtl">
      <div className="rounded-3xl border-2 border-[#E5E5E5] border-b-4 bg-white p-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-black text-[#3C3C3C]">عنوان الاختبار</span>
          <MathField
            value={title}
            onChange={setTitle}
            maxLength={LIMITS.title}
            placeholder="مثال: اختبار الجذور والأسس — الفصل الأول"
            onFocusField={onFocusField}
          />
        </label>
        <div className="flex items-center justify-between gap-2 text-[11px] font-extrabold text-[#777777]">
          <span>{filled} سؤال جاهز للحفظ</span>
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            className="flex items-center gap-1 text-[#1899D6] cursor-pointer"
          >
            {showPreview ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {showPreview ? 'إخفاء المعاينة' : 'إظهار المعاينة'}
          </button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="rounded-2xl border-2 border-[#FFC800] bg-[#FFF4CC] p-3 text-xs font-extrabold text-[#8A6500] flex flex-col gap-1">
          <div className="flex items-center gap-1.5 font-black">
            <AlertTriangle className="w-4 h-4" /> ملاحظات أثناء قراءة الملف
          </div>
          {warnings.slice(0, 12).map((w, i) => (
            <div key={i}>• {w}</div>
          ))}
          {warnings.length > 12 && <div>… و{warnings.length - 12} ملاحظة أخرى</div>}
        </div>
      )}

      {/* شريط الرموز: يلتصق أعلى الشاشة أثناء التمرير */}
      <div className="sticky top-14 sm:top-16 z-20">
        <MathToolbar onInsert={insertSnippet} disabled={!hasActive} />
        {!hasActive && (
          <p className="text-[10px] font-extrabold text-[#1899D6] mt-1">
            اضغط داخل أي حقل (عنوان/سؤال/خيار) أولاً ثم اختر الرمز.
          </p>
        )}
      </div>

      {questions.length > PAGE_SIZE && (
        <div className="rounded-2xl border-2 border-[#1CB0F6]/40 bg-[#F0FAFF] p-3 flex flex-wrap items-center justify-between gap-2 text-xs font-black text-[#3C3C3C]">
          <span>
            إجمالي الأسئلة: <span className="font-latin text-[#1899D6]">{questions.length}</span> سؤالاً
            {isPaginated
              ? ` (معروض الآن ${startIdx + 1} – ${Math.min(startIdx + PAGE_SIZE, questions.length)})`
              : ' (معروض الكل)'}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {!showAllQuestions &&
              Array.from({ length: totalPages }, (_, pIdx) => (
                <button
                  key={pIdx}
                  type="button"
                  onClick={() => setPage(pIdx)}
                  className={`px-2.5 py-1 rounded-xl border text-[11px] font-latin font-black cursor-pointer ${
                    safePage === pIdx
                      ? 'bg-[#1CB0F6] border-[#1899D6] text-white'
                      : 'bg-white border-[#E5E5E5] text-[#3C3C3C]'
                  }`}
                >
                  {pIdx * PAGE_SIZE + 1}–{Math.min((pIdx + 1) * PAGE_SIZE, questions.length)}
                </button>
              ))}
            <button
              type="button"
              onClick={() => setShowAllQuestions((v) => !v)}
              className="px-2.5 py-1 rounded-xl bg-white border border-[#1CB0F6] text-[#1899D6] text-[11px] font-black cursor-pointer"
            >
              {showAllQuestions ? 'تقسيم لصفحات (50 لكل صفحة)' : `عرض الكل (${questions.length})`}
            </button>
          </div>
        </div>
      )}

      {visibleQuestions.map((q, localIdx) => {
        const idx = startIdx + localIdx;
        const isTable = q.questionType === 'table' || (Boolean(q.table) && q.choices.length === 0);
        const hasChoices = !isTable && q.choices.length > 0;
        return (
          <div key={q.id} className="rounded-3xl border-2 border-[#E5E5E5] border-b-4 bg-white p-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="px-3 py-1 rounded-full bg-[#DDF4FF] text-[#1899D6] text-xs font-black">
                  السؤال {idx + 1}
                </span>
                <div className="inline-flex rounded-xl border-2 border-[#E5E5E5] bg-[#F7F7F7] p-0.5 text-[11px] font-black">
                  <button
                    type="button"
                    onClick={() =>
                      patch(q.id, {
                        questionType: 'mcq',
                        choices: q.choices.length >= 2 ? q.choices : ['', '', '', ''],
                        table: undefined,
                      })
                    }
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-lg cursor-pointer transition-colors ${
                      !isTable ? 'bg-white text-[#1899D6] shadow-xs' : 'text-[#777777] hover:text-[#3C3C3C]'
                    }`}
                  >
                    <ListChecks className="w-3.5 h-3.5" />
                    <span>اختيارات</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      patch(q.id, {
                        questionType: 'table',
                        table: q.table ?? createDefaultTableQuestion(),
                        choices: [],
                        correctIndex: -1,
                      })
                    }
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-lg cursor-pointer transition-colors ${
                      isTable ? 'bg-white text-[#8938D6] shadow-xs' : 'text-[#777777] hover:text-[#3C3C3C]'
                    }`}
                  >
                    <Table2 className="w-3.5 h-3.5" />
                    <span>جدول تفاعلي</span>
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => move(idx, -1)} disabled={idx === 0} title="للأعلى" className="p-1.5 rounded-lg text-[#777777] hover:bg-[#F7F7F7] disabled:opacity-30 cursor-pointer">
                  <ArrowUp className="w-4 h-4" />
                </button>
                <button type="button" onClick={() => move(idx, 1)} disabled={idx === questions.length - 1} title="للأسفل" className="p-1.5 rounded-lg text-[#777777] hover:bg-[#F7F7F7] disabled:opacity-30 cursor-pointer">
                  <ArrowDown className="w-4 h-4" />
                </button>
                <button type="button" onClick={() => duplicate(idx)} title="نسخ السؤال" className="p-1.5 rounded-lg text-[#777777] hover:bg-[#F7F7F7] cursor-pointer">
                  <Copy className="w-4 h-4" />
                </button>
                <button type="button" onClick={() => remove(q.id)} title="حذف السؤال" className="p-1.5 rounded-lg text-[#EA2B2B] hover:bg-[#FFDFE0] cursor-pointer">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            <MathField
              multiline
              rows={3}
              value={q.text}
              onChange={(v) => patch(q.id, { text: v })}
              maxLength={LIMITS.text}
              placeholder={
                isTable
                  ? 'اكتب رأس السؤال للجدول (مثال: أكمل الخانات الفارغة في الجدول التالي...)'
                  : 'اكتب نص السؤال… (استخدم شريط الرموز للجذور والكسور)'
              }
              onFocusField={onFocusField}
            />
            {showPreview && q.text.trim() && (
              <div className="rounded-2xl bg-[#F7F7F7] border border-[#E5E5E5] px-3 py-2 text-sm font-bold text-[#3C3C3C]">
                <MathText text={q.text} />
              </div>
            )}

            <div className="flex flex-wrap items-start gap-2">
              <QuizChartEditor chart={q.chart} onChange={(c) => patch(q.id, { chart: c })} />
              <QuizFigureEditor figure={q.figure} onChange={(f) => patch(q.id, { figure: f })} />
            </div>

            {isTable ? (
              <div className="flex flex-col gap-3">
                <QuizTableEditor
                  table={q.table ?? createDefaultTableQuestion()}
                  onChange={(t) => patch(q.id, { questionType: 'table', table: t, choices: [], correctIndex: -1 })}
                />
                {showPreview && q.table && (
                  <div className="rounded-2xl bg-[#F8FAFC] border border-[#E5E5E5] p-3 flex flex-col gap-1.5">
                    <span className="text-[11px] font-black text-[#777777]">معاينة الجدول كما سيظهر للطالب:</span>
                    <QuestionTableView table={q.table} mode="preview" />
                  </div>
                )}
              </div>
            ) : hasChoices ? (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-black text-[#3C3C3C]">الخيارات (اختر الصحيح بالدائرة)</span>
                {q.choices.map((c, ci) => (
                  <div key={ci} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => patch(q.id, { correctIndex: ci, answer: c })}
                        title="الإجابة الصحيحة"
                        className={`w-7 h-7 shrink-0 rounded-full border-2 flex items-center justify-center cursor-pointer ${
                          q.correctIndex === ci
                            ? 'bg-[#58CC02] border-[#46A302] text-white'
                            : 'bg-white border-[#E5E5E5] text-transparent'
                        }`}
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <MathField
                        value={c}
                        onChange={(v) => {
                          const choices = q.choices.slice();
                          choices[ci] = v;
                          patch(q.id, { choices, answer: q.correctIndex === ci ? v : q.answer });
                        }}
                        maxLength={LIMITS.choice}
                        placeholder={`الخيار ${ci + 1}`}
                        onFocusField={onFocusField}
                      />
                      <button
                        type="button"
                        disabled={q.choices.length <= 2}
                        onClick={() => {
                          const choices = q.choices.filter((_, k) => k !== ci);
                          let correctIndex = q.correctIndex;
                          if (correctIndex === ci) correctIndex = -1;
                          else if (correctIndex > ci) correctIndex -= 1;
                          patch(q.id, { choices, correctIndex, answer: correctIndex >= 0 ? choices[correctIndex] : '' });
                        }}
                        className="p-1.5 rounded-lg text-[#EA2B2B] cursor-pointer disabled:opacity-30"
                        title="حذف الخيار"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    {showPreview && /[$\\^_]/.test(c) && (
                      <div className="mr-9 text-sm font-bold text-[#3C3C3C]">
                        <MathText text={c} />
                      </div>
                    )}
                  </div>
                ))}
                <div className="flex items-center gap-3">
                  {q.choices.length < LIMITS.maxChoices && (
                    <button
                      type="button"
                      onClick={() => patch(q.id, { choices: [...q.choices, ''] })}
                      className="text-xs font-black text-[#1899D6] cursor-pointer"
                    >
                      + إضافة خيار
                    </button>
                  )}
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-black text-[#3C3C3C]">شرح الحل (اختياري — يدعم الكسور والجذور والجداول والمقارنات والأشكال)</span>
                <MathField
                  multiline
                  rows={2}
                  value={q.explanation}
                  onChange={(v) => patch(q.id, { explanation: v })}
                  maxLength={LIMITS.explanation}
                  placeholder="خطوات الحل أو القوانين أو جدول مقارنة بصيغة Markdown باستخدام | ..."
                  onFocusField={onFocusField}
                />
              </label>
              {showPreview &&
                (q.explanation.trim() ||
                  q.explanationTable ||
                  q.explanationComparison ||
                  q.explanationChart ||
                  q.explanationFigure) && (
                  <RichExplanationView
                    explanation={q.explanation}
                    explanationTable={q.explanationTable}
                    explanationComparison={q.explanationComparison}
                    explanationChart={q.explanationChart}
                    explanationFigure={q.explanationFigure}
                  />
                )}
              <div className="flex flex-wrap items-start gap-2">
                <QuizChartEditor
                  chart={q.explanationChart}
                  onChange={(c) => patch(q.id, { explanationChart: c })}
                  buttonLabel="إضافة رسم بياني في الشرح"
                  headerTitle="الرسم البياني داخل الشرح"
                />
                <QuizFigureEditor
                  figure={q.explanationFigure}
                  onChange={(f) => patch(q.id, { explanationFigure: f })}
                  buttonLabel="إضافة شكل هندسي في الشرح"
                  headerTitle="الشكل الهندسي داخل الشرح"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => void copyText(q.id, q.text)}
              className="self-start text-[10px] font-extrabold text-[#777777] cursor-pointer"
            >
              {copiedId === q.id ? 'تم نسخ النص ✓' : 'نسخ نص السؤال'}
            </button>
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => addQuestion('mcq')}
          disabled={questions.length >= LIMITS.maxQuestions}
          className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-white border-2 border-[#E5E5E5] border-b-4 text-sm font-black text-[#1899D6] cursor-pointer disabled:opacity-50"
        >
          <PlusCircle className="w-4 h-4" /> إضافة سؤال خيارات
        </button>
        <button
          type="button"
          onClick={() => addQuestion('table')}
          disabled={questions.length >= LIMITS.maxQuestions}
          className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-[#F5ECFF] border-2 border-[#CE82FF] border-b-4 text-sm font-black text-[#8938D6] cursor-pointer disabled:opacity-50"
        >
          <Table2 className="w-4 h-4" /> إضافة سؤال جدول تفاعلي
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-xs font-extrabold text-[#EA2B2B]">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2 sticky bottom-2 z-20">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="duo-btn flex-1 flex items-center justify-center gap-2 px-5 py-3 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-[#46A302] border-b-4 text-white text-sm font-black cursor-pointer disabled:opacity-60"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {editingId ? 'حفظ التعديلات' : 'إضافة إلى اختباراتي'}
        </button>
        <button
          type="button"
          onClick={() => {
            const empty = !title.trim() && questions.every((q) => !q.text.trim());
            if (empty) void deleteSessionSnapshot('my_quiz_draft');
            onCancel();
          }}
          disabled={saving}
          className="px-4 py-3 rounded-2xl bg-white border-2 border-[#E5E5E5] border-b-4 text-sm font-black text-[#777777] cursor-pointer"
        >
          رجوع
        </button>
      </div>
      {saving && (
        <DuoLoading
          variant="overlay"
          title="جاري حفظ الاختبار والأشكال الهندسية..."
          subtitle="يتم مزامنة الأسئلة والرسومات مع قاعدة البيانات بأمان"
          accent="green"
        />
      )}
    </div>
  );
};
