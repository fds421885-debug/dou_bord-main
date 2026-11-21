import React, { useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ClipboardCopy,
  Dumbbell,
  Layers,
  Loader2,
  Play,
  PlusCircle,
  RefreshCw,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import type { DrillStyle, MyQuiz, QuizQuestion } from '../types';
import {
  buildDrillPromptForQuestion,
  createMyQuizzesAutoSplit,
  DRILL_STYLE_LABELS,
  parseQuizBundleJson,
} from '../myQuizzes';
import { MathText } from '../mathText';
import { playDuoSound } from './DuoIcons';

interface CreateDrillModalProps {
  open: boolean;
  ownerId: string;
  question: QuizQuestion;
  sourceTitle?: string;
  sourceQuizId?: string;
  sourceStarredId?: string;
  mainQuizzes: MyQuiz[];
  onClose: () => void;
  onCreated: (createdQuizzes: MyQuiz[]) => void;
  onStartQuizNow: (quiz: MyQuiz) => void;
}

const STYLE_OPTIONS: Array<{
  id: DrillStyle;
  title: string;
  desc: string;
}> = [
  {
    id: 'same_values',
    title: 'نفسه مع تغيير القيم',
    desc: 'نفس المسألة والقالب والخطوات مع تغيير الأرقام فقط لتثبيت الطريقة دون أخطاء.',
  },
  {
    id: 'same_law_ideas',
    title: 'نفس القانون بأفكار مختلفة',
    desc: 'نفس القاعدة أو القانون لكن بأفكار وزوايا صياغة جديدة ومتنوعة.',
  },
  {
    id: 'mixed',
    title: 'متنوع وشامل',
    desc: 'تدرج من مسائل مباشرة ثم متوسطة ثم قدرات متقدمة وجداول على نفس المهارة.',
  },
];

export const CreateDrillModal: React.FC<CreateDrillModalProps> = ({
  open,
  ownerId,
  question,
  sourceTitle,
  sourceQuizId,
  sourceStarredId,
  mainQuizzes,
  onClose,
  onCreated,
  onStartQuizNow,
}) => {
  const defaultParentId = useMemo(() => {
    if (sourceQuizId && mainQuizzes.some((q) => q.id === sourceQuizId)) {
      return sourceQuizId;
    }
    return '';
  }, [sourceQuizId, mainQuizzes]);

  const [drillTitle, setDrillTitle] = useState(
    () => `تقوية: ${question.text.replace(/\s+/g, ' ').trim().slice(0, 42) || 'مسألة مميزة'}`
  );
  const [parentQuizId, setParentQuizId] = useState<string>(defaultParentId);
  const [questionCount, setQuestionCount] = useState<number>(10);
  const [drillStyle, setDrillStyle] = useState<DrillStyle>('mixed');
  const [customNote, setCustomNote] = useState('');

  const [generatedPrompt, setGeneratedPrompt] = useState<string | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [rawJson, setRawJson] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdList, setCreatedList] = useState<MyQuiz[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const handleGeneratePrompt = () => {
    setError(null);
    const prompt = buildDrillPromptForQuestion({
      question,
      sourceTitle,
      questionCount,
      drillStyle,
      suggestedTitle: drillTitle.trim() || undefined,
      customNote,
    });
    setGeneratedPrompt(prompt);
    playDuoSound('pop');
  };

  const handleCopyPrompt = async () => {
    if (!generatedPrompt) return;
    try {
      await navigator.clipboard.writeText(generatedPrompt);
      setCopiedPrompt(true);
      playDuoSound('pop');
      window.setTimeout(() => setCopiedPrompt(false), 1800);
    } catch {
      // Clipboard fallback: user can select text directly
    }
  };

  const handleUploadJson = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 15_000_000) {
      setError('حجم الملف كبير جداً (الحد الأقصى 15MB).');
      return;
    }
    setRawJson(await file.text());
    setError(null);
  };

  const handleCreateQuizFromJson = async () => {
    setError(null);
    if (!rawJson.trim()) {
      setError('الصق JSON الناتج من الذكاء الاصطناعي أولاً.');
      return;
    }

    let parsed;
    try {
      parsed = parseQuizBundleJson(rawJson);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر قراءة JSON.');
      return;
    }

    setSaving(true);
    try {
      const targetParentId = parentQuizId.trim() || undefined;
      const quizzesToCreate: Array<{
        title: string;
        questions: QuizQuestion[];
        style: DrillStyle;
        ruleTitle?: string;
      }> = [
        {
          title: (drillTitle.trim() || parsed.title || 'اختبار تقوية').slice(0, 120),
          questions: parsed.questions,
          style: parsed.drillStyle || drillStyle,
          ruleTitle: parsed.ruleTitle,
        },
        ...parsed.subQuizzes.map((sq) => ({
          title: sq.title.slice(0, 120),
          questions: sq.questions,
          style: sq.drillStyle || drillStyle,
          ruleTitle: sq.ruleTitle,
        })),
      ];

      const savedItems: MyQuiz[] = [];
      for (const item of quizzesToCreate) {
        const meta = {
          ...(targetParentId ? { parentQuizId: targetParentId } : {}),
          quizKind: 'drill' as const,
          drillStyle: item.style,
          ...(sourceStarredId ? { sourceStarredId } : {}),
          ...(item.ruleTitle ? { ruleTitle: item.ruleTitle } : {}),
        };
        const createdChunks = await createMyQuizzesAutoSplit(
          ownerId,
          item.title,
          item.questions,
          meta
        );
        for (const chunk of createdChunks) {
          savedItems.push({
            id: chunk.id,
            ownerId,
            title: chunk.title,
            questions: chunk.questions,
            questionCount: chunk.questions.length,
            ...meta,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      }

      playDuoSound('correct');
      setCreatedList(savedItems);
      setRawJson('');
      onCreated(savedItems);
    } catch (err) {
      playDuoSound('wrong');
      setError(err instanceof Error ? err.message : 'تعذر حفظ اختبار التقوية.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4"
      dir="rtl"
    >
      <div className="duo-card max-w-2xl w-full p-4 sm:p-6 bg-white border-2 border-[#A560E8] flex flex-col gap-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 pb-3 border-b-2 border-[#F0F0F0]">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-[#A560E8] border-b-4 border-[#8938D6] text-white flex items-center justify-center shrink-0">
              <Dumbbell className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-black text-[#3C3C3C]">
                إنشاء اختبار تقوية مخصص على المسألة
              </h2>
              <p className="text-[11px] sm:text-xs font-bold text-[#777777]">
                حدّد عدد الأسئلة والأسلوب، ثم انسخ البرومبت لأي ذكاء اصطناعي وألصق JSON الناتج ليتحول فوراً إلى تدريب تحت الاختبار الأساسي.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-[#F7F7F7] text-[#777777] cursor-pointer shrink-0"
            title="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Reference question preview */}
        <div className="p-3 rounded-2xl bg-[#FFF9E6] border-2 border-[#FFC800]/60 flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2 text-[11px] font-black text-[#9A6B00]">
            <span>المسألة المرجعية</span>
            {sourceTitle && <span>من: {sourceTitle}</span>}
          </div>
          <MathText
            text={question.text}
            className="text-xs sm:text-sm font-black text-[#3C3C3C] line-clamp-3"
          />
        </div>

        {/* Success banner after creation */}
        {createdList.length > 0 && (
          <div className="p-4 rounded-2xl bg-[#D7FFB8] border-2 border-[#58CC02] flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm font-black text-[#46A302]">
              <CheckCircle2 className="w-5 h-5 shrink-0" />
              <span>
                تم إنشاء وحفظ {createdList.length === 1 ? `«${createdList[0].title}»` : `${createdList.length} اختبارات تقوية`} بنجاح!
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onStartQuizNow(createdList[0])}
                className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer"
              >
                <Play className="w-4 h-4" />
                <span>ابدأ اختبار التقوية الآن</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreatedList([]);
                  setGeneratedPrompt(null);
                }}
                className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#8938D6] text-xs font-black cursor-pointer"
              >
                <PlusCircle className="w-4 h-4" />
                <span>إنشاء اختبار تقوية آخر</span>
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-2 text-xs font-black text-[#3C3C3C] hover:underline cursor-pointer"
              >
                إغلاق والعودة
              </button>
            </div>
          </div>
        )}

        {/* Settings Form */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="drill-title-inp" className="text-xs font-black text-[#3C3C3C]">
              عنوان اختبار التقوية
            </label>
            <input
              id="drill-title-inp"
              type="text"
              maxLength={120}
              value={drillTitle}
              onChange={(e) => setDrillTitle(e.target.value)}
              className="px-3 py-2 rounded-xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#A560E8] focus:bg-white outline-none text-xs sm:text-sm font-bold text-[#3C3C3C]"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="drill-parent-sel" className="text-xs font-black text-[#3C3C3C] flex items-center gap-1">
              <Layers className="w-3.5 h-3.5 text-[#8938D6]" />
              <span>وضع الاختبار تحت:</span>
            </label>
            <select
              id="drill-parent-sel"
              value={parentQuizId}
              onChange={(e) => setParentQuizId(e.target.value)}
              className="px-3 py-2 rounded-xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#A560E8] focus:bg-white outline-none text-xs sm:text-sm font-bold text-[#3C3C3C]"
            >
              {mainQuizzes.map((mq) => (
                <option key={mq.id} value={mq.id}>
                  تحت: {mq.title}
                </option>
              ))}
              <option value="">تقوية عامة (مستقلة)</option>
            </select>
          </div>
        </div>

        {/* Question Count */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-black text-[#3C3C3C]">كم عدد الأسئلة المطلوبة في هذا التدريب؟</span>
          <div className="flex flex-wrap items-center gap-2">
            {[5, 10, 15, 20, 30].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  setQuestionCount(n);
                  setGeneratedPrompt(null);
                }}
                className={`px-3.5 py-1.5 rounded-xl border-2 text-xs font-black font-latin cursor-pointer ${
                  questionCount === n
                    ? 'bg-[#A560E8] border-[#8938D6] text-white'
                    : 'bg-white border-[#E5E5E5] text-[#3C3C3C] hover:border-[#A560E8]'
                }`}
              >
                {n}
              </button>
            ))}
            <input
              type="number"
              min={1}
              max={1000}
              dir="ltr"
              value={questionCount}
              onChange={(e) => {
                const v = Math.max(1, Math.min(1000, parseInt(e.target.value, 10) || 1));
                setQuestionCount(v);
                setGeneratedPrompt(null);
              }}
              className="w-20 px-2.5 py-1.5 rounded-xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#A560E8] outline-none text-xs font-black font-latin text-center"
            />
            <span className="text-[11px] font-bold text-[#777777]">سؤال (يمكنك كتابة أي عدد)</span>
          </div>
        </div>

        {/* Style Selector */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-black text-[#3C3C3C]">نمط الأسئلة المطلوبة:</span>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {STYLE_OPTIONS.map((opt) => {
              const active = drillStyle === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    setDrillStyle(opt.id);
                    setGeneratedPrompt(null);
                  }}
                  className={`p-3 rounded-2xl border-2 text-right cursor-pointer transition-colors flex flex-col gap-1 ${
                    active
                      ? 'bg-[#F5ECFF] border-[#A560E8] text-[#3C3C3C]'
                      : 'bg-white border-[#E5E5E5] text-[#555555] hover:border-[#A560E8]/60'
                  }`}
                >
                  <div className="text-xs font-black text-[#8938D6]">{opt.title}</div>
                  <div className="text-[11px] font-bold leading-relaxed text-[#666666]">{opt.desc}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Optional Note */}
        <div className="flex flex-col gap-1">
          <label htmlFor="drill-note-inp" className="text-xs font-black text-[#3C3C3C]">
            ملاحظة أو طلب إضافي للـ AI (اختياري)
          </label>
          <input
            id="drill-note-inp"
            type="text"
            maxLength={250}
            value={customNote}
            onChange={(e) => {
              setCustomNote(e.target.value);
              setGeneratedPrompt(null);
            }}
            placeholder="مثال: أضف أسئلة جداول تفاعلية، أو ركّز على الحساب الذهني السريع..."
            className="px-3 py-2 rounded-xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#A560E8] focus:bg-white outline-none text-xs font-bold text-[#3C3C3C]"
          />
        </div>

        {/* Step 1: Generate Prompt */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleGeneratePrompt}
            className="duo-btn flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-b-4 border-[#1899D6] text-white text-xs sm:text-sm font-black cursor-pointer"
          >
            <Sparkles className="w-4 h-4" />
            <span>{generatedPrompt ? 'تحديث البرومبت' : '1. أنشئ برومبت الذكاء الاصطناعي'}</span>
          </button>
          <span className="text-[11px] font-bold text-[#777777]">
            النمط المختار: {DRILL_STYLE_LABELS[drillStyle]}
          </span>
        </div>

        {generatedPrompt && (
          <div className="p-3.5 rounded-2xl bg-[#F0F9FF] border-2 border-[#1CB0F6]/50 flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-black text-[#1899D6]">
                انسخ هذا البرومبت وأعطه للذكاء الاصطناعي (ChatGPT / Gemini / Claude):
              </span>
              <button
                type="button"
                onClick={() => void handleCopyPrompt()}
                className="duo-btn flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[#1CB0F6] border-2 border-b-4 border-[#1899D6] text-white text-xs font-black cursor-pointer"
              >
                <ClipboardCopy className="w-3.5 h-3.5" />
                <span>{copiedPrompt ? 'تم نسخ البرومبت ✓' : 'نسخ البرومبت'}</span>
              </button>
            </div>
            <textarea
              readOnly
              rows={5}
              value={generatedPrompt}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full p-2.5 rounded-xl bg-white border border-[#BFE6FC] text-[11px] font-bold text-[#3C3C3C] leading-relaxed outline-none"
            />
          </div>
        )}

        {/* Step 2: Paste JSON right here */}
        <div className="p-3.5 rounded-2xl bg-[#FAF7FF] border-2 border-[#A560E8]/50 flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-black text-[#5C1A99]">
              2. الصق ملف JSON الناتج من الـ AI هنا لإنشاء اختبار التقوية مباشرة:
            </span>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1 text-[11px] font-black text-[#8938D6] hover:underline cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>أو رفع ملف JSON</span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json,text/plain"
              className="hidden"
              onChange={(e) => void handleUploadJson(e.target.files?.[0])}
            />
          </div>

          <textarea
            dir="ltr"
            rows={5}
            value={rawJson}
            onChange={(e) => {
              setRawJson(e.target.value);
              setError(null);
            }}
            placeholder='{ "title": "...", "questions": [ ... ] }'
            className="w-full p-2.5 rounded-xl bg-white border-2 border-[#E5E5E5] focus:border-[#A560E8] outline-none font-latin text-xs leading-relaxed text-[#3C3C3C]"
          />

          {error && (
            <div className="p-2.5 rounded-xl bg-[#FFDFE0] border border-[#FF4B4B] text-xs font-black text-[#EA2B2B]">
              {error}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              disabled={saving || !rawJson.trim()}
              onClick={() => void handleCreateQuizFromJson()}
              className="duo-btn flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-xs sm:text-sm font-black cursor-pointer disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              <span>{saving ? 'جاري الإنشاء والحفظ...' : 'إنشاء وحفظ اختبار التقوية الآن'}</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 text-xs font-black text-[#777777] cursor-pointer"
            >
              إلغاء
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
