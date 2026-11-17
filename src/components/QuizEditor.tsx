import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  PlusCircle,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type { QuizQuestion } from '../types';
import { MathText } from '../mathText';
import { applySnippet, MathToolbar } from './MathToolbar';
import { QuizChartEditor } from './QuizChartEditor';
import { QuizFigureEditor } from './QuizFigureEditor';
import {
  cleanQuestions,
  createMyQuiz,
  emptyQuestion,
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
          if (q.choices.length >= 2) return q;
          const choices = [...q.choices];
          while (choices.length < 4) choices.push('');
          return { ...q, choices, correctIndex: -1 };
        })
      : [emptyQuestion()]
  );
  const [showPreview, setShowPreview] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const activeRef = useRef<ActiveField | null>(null);
  const [hasActive, setHasActive] = useState(false);

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

  const addQuestion = () =>
    setQuestions((qs) => (qs.length >= LIMITS.maxQuestions ? qs : [...qs, emptyQuestion()]));

  const filled = useMemo(() => cleanQuestions(questions).length, [questions]);

  const handleSave = async () => {
    const problem = validateForSave(title, questions);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await updateMyQuiz(ownerId, editingId, title, questions);
      } else {
        await createMyQuiz(ownerId, title, questions);
      }
      await deleteSessionSnapshot('my_quiz_draft');
      onDone(editingId ? 'تم حفظ التعديلات.' : 'تمت إضافة الاختبار إلى اختباراتي.');
    } catch (e) {
      let msg = 'تعذر الحفظ. تحقق من الاتصال وحاول مرة أخرى. مسودتك محفوظة على جهازك.';
      const raw = e instanceof Error ? e.message : '';
      if (/permission-denied|permission_denied/i.test(raw)) {
        msg =
          'قاعدة البيانات رفضت الحفظ لأن قواعد الأمان (firestore.rules) لم تُحدَّث بعد بالإصدار الجديد. انسخها من المشروع وانشرها في Firebase، ثم أعد المحاولة. مسودتك محفوظة.';
      } else if (/quota|resource-exhausted/i.test(raw)) {
        msg = 'انتهت حصة قاعدة البيانات مؤقتاً. مسودتك محفوظة على جهازك، حاول لاحقاً أو انقل البيانات لقاعدة أخرى.';
      }
      setError(msg);
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

      {questions.map((q, idx) => {
        const hasChoices = q.choices.length > 0;
        return (
          <div key={q.id} className="rounded-3xl border-2 border-[#E5E5E5] border-b-4 bg-white p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <span className="px-3 py-1 rounded-full bg-[#DDF4FF] text-[#1899D6] text-xs font-black">
                السؤال {idx + 1}
              </span>
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
              placeholder="اكتب نص السؤال… (استخدم شريط الرموز للجذور والكسور)"
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

            {/* الخيارات */}
            {hasChoices ? (
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
                <span className="text-xs font-black text-[#3C3C3C]">شرح الحل (اختياري — يدعم الكسور والجذور والأشكال)</span>
                <MathField
                  multiline
                  rows={2}
                  value={q.explanation}
                  onChange={(v) => patch(q.id, { explanation: v })}
                  maxLength={LIMITS.explanation}
                  placeholder="خطوات الحل أو المعادلات باستخدام شريط الرموز…"
                  onFocusField={onFocusField}
                />
              </label>
              {showPreview && q.explanation.trim() && (
                <div className="rounded-2xl bg-[#F7F7F7] border border-[#E5E5E5] px-3 py-2 text-sm font-bold text-[#3C3C3C]">
                  <span className="block text-[11px] font-black text-[#777777] mb-0.5">معاينة الشرح:</span>
                  <MathText text={q.explanation} />
                </div>
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
          onClick={addQuestion}
          disabled={questions.length >= LIMITS.maxQuestions}
          className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-white border-2 border-[#E5E5E5] border-b-4 text-sm font-black text-[#1899D6] cursor-pointer disabled:opacity-50"
        >
          <PlusCircle className="w-4 h-4" /> إضافة سؤال
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
    </div>
  );
};
