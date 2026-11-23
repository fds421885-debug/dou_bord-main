import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Award,
  BarChart3,
  Bot,
  Brain,
  CheckCircle2,
  Clock,
  Compass,
  Dumbbell,
  Flame,
  Gauge,
  HeartHandshake,
  Layers,
  Loader2,
  Lock,
  MessageCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  UserCheck,
  Zap,
} from 'lucide-react';
import { buildLocalCoachAnalytics } from '../aiCoachAnalytics';
import { MathText } from '../mathText';
import {
  buildDirectMistakeReviewQuestions,
  buildFoundationalPlanFromDiagnosis,
  checkAiServerStatus,
  createEmptyCoachState,
  generateAiMistakeReviewQuestions,
  generateAndSaveSectionQuiz,
  requestAiDiagnosis,
  saveCoachStateToCloud,
  sendAiCoachChatMessage,
  subscribeCoachState,
} from '../aiCoachClient';
import type {
  CoachChatMessage,
  CoachQuickQuiz,
  CoachStateDoc,
  CoachTopicStat,
  FoundationalStage,
  MyQuiz,
  QuizAttempt,
  QuizQuestion,
  StarredQuestion,
  UserProfile,
} from '../types';

interface Props {
  profile: UserProfile;
  attempts: QuizAttempt[];
  quizzes: MyQuiz[];
  starredItems: StarredQuestion[];
  onStartQuiz: (quiz: MyQuiz) => void;
  onStartQuickQuiz: (quickQuiz: CoachQuickQuiz, messageId: string) => void;
  onStartMistakesReview: (questions: QuizQuestion[], title: string) => void;
}

const card = 'rounded-3xl border-2 border-[#E5E5E5] border-b-4 bg-white';

export const SmartAssistantView: React.FC<Props> = ({
  profile,
  attempts,
  quizzes,
  starredItems,
  onStartQuiz,
  onStartQuickQuiz,
  onStartMistakesReview,
}) => {
  const [coachState, setCoachState] = useState<CoachStateDoc>(() =>
    createEmptyCoachState(profile.uid)
  );
  const [aiStatus, setAiStatus] = useState<{
    checked: boolean;
    reachable: boolean;
    aiConfigured: boolean;
  }>({ checked: false, reachable: false, aiConfigured: false });

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const [selectedSectionKey, setSelectedSectionKey] = useState<string>('');
  const [drillCount, setDrillCount] = useState<number>(5);
  const [generatingQuiz, setGeneratingQuiz] = useState(false);
  const [generatingStageId, setGeneratingStageId] = useState<string | null>(null);
  const [quizGenError, setQuizGenError] = useState<string | null>(null);
  const [lastCreatedQuiz, setLastCreatedQuiz] = useState<MyQuiz | null>(null);

  const [mistakeScope, setMistakeScope] = useState<'all' | 'section'>('all');
  const [generatingMistakeQuiz, setGeneratingMistakeQuiz] = useState(false);
  const [mistakeQuizError, setMistakeQuizError] = useState<string | null>(null);

  const [chatInput, setChatInput] = useState('');
  const [sendingChat, setSendingChat] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [editingMemoryName, setEditingMemoryName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const autoAnalyzedOnceRef = useRef(false);

  useEffect(() => {
    const unsub = subscribeCoachState(profile.uid, (next) => {
      setCoachState(next);
    });
    return unsub;
  }, [profile.uid]);

  useEffect(() => {
    let alive = true;
    void checkAiServerStatus().then((res) => {
      if (alive) {
        setAiStatus({
          checked: true,
          reachable: res.reachable,
          aiConfigured: res.aiConfigured,
        });
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const analytics = useMemo(
    () =>
      buildLocalCoachAnalytics({
        attempts,
        quizzes,
        starredItems,
        sectionProgress: coachState.sectionProgress,
      }),
    [attempts, quizzes, starredItems, coachState.sectionProgress]
  );

  // اختيار القسم تلقائياً بناءً على توصية الذكاء الاصطناعي أو الأولوية المحلية
  useEffect(() => {
    if (selectedSectionKey && analytics.sectionStats.some((s) => s.sectionKey === selectedSectionKey)) {
      return;
    }
    const recKey = coachState.diagnosis?.recommendedSectionKey;
    if (recKey && analytics.sectionStats.some((s) => s.sectionKey === recKey)) {
      setSelectedSectionKey(recKey);
      return;
    }
    if (analytics.prioritySection) {
      setSelectedSectionKey(analytics.prioritySection.sectionKey);
      return;
    }
    const firstParent = quizzes.find((q) => !q.parentQuizId && q.quizKind !== 'drill');
    if (firstParent) {
      setSelectedSectionKey(firstParent.id);
    }
  }, [analytics, coachState.diagnosis, quizzes, selectedSectionKey]);

  const activeSectionStat: CoachTopicStat | null = useMemo(() => {
    return (
      analytics.sectionStats.find((s) => s.sectionKey === selectedSectionKey) ||
      analytics.prioritySection ||
      analytics.sectionStats[0] ||
      null
    );
  }, [analytics, selectedSectionKey]);

  const activeSectionTitle = useMemo(() => {
    if (activeSectionStat) return activeSectionStat.sectionTitle;
    const matchQuiz = quizzes.find((q) => q.id === selectedSectionKey);
    return matchQuiz?.title || 'القسم العام';
  }, [activeSectionStat, quizzes, selectedSectionKey]);

  const preferredName =
    coachState.memory.studentPreferredName ||
    profile.fullNameQuad.split(' ').slice(0, 2).join(' ') ||
    'بطل';

  const runDeepAnalysis = async () => {
    if (analyzing || analytics.totalQuestions === 0) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const diag = await requestAiDiagnosis({
        studentName: profile.fullNameQuad,
        analytics,
        memory: coachState.memory,
      });

      let nextPlan = coachState.activeFoundationalPlan;
      if (
        (diag.suggestedPlan && diag.suggestedPlan.stages?.length) ||
        analytics.sectionNeedsFoundationalPlan
      ) {
        const planTargetKey =
          analytics.sectionNeedsFoundationalPlan?.sectionKey ||
          diag.recommendedSectionKey ||
          activeSectionStat?.sectionKey ||
          '';
        const planTargetTitle =
          analytics.sectionNeedsFoundationalPlan?.sectionTitle ||
          diag.recommendedSectionTitle ||
          activeSectionTitle;
        if (!nextPlan || nextPlan.completedAt || nextPlan.sectionKey !== planTargetKey) {
          nextPlan = buildFoundationalPlanFromDiagnosis(planTargetKey, planTargetTitle, diag);
        }
      }

      const nextState: CoachStateDoc = {
        ...coachState,
        diagnosis: diag,
        activeFoundationalPlan: nextPlan,
        updatedAt: Date.now(),
      };
      setCoachState(nextState);
      await saveCoachStateToCloud(profile.uid, nextState);
      if (diag.recommendedSectionKey) {
        setSelectedSectionKey(diag.recommendedSectionKey);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setAnalyzeError(
        msg === 'BACKEND_UNAVAILABLE'
          ? 'الخادم الذكي غير متصل في هذه الاستضافة الثابتة حالياً، تُعرض التحليلات الدقيقة المحلية مع جاهزية الترقية عند ربط الخادم.'
          : msg || 'تعذر إتمام التحليل الذكي الآن.'
      );
    } finally {
      setAnalyzing(false);
    }
  };

  // تشغيل التحليل تلقائياً عند أول دخول إذا توفر خادم وبيانات ولم يتم تحليله مؤخراً
  useEffect(() => {
    if (
      autoAnalyzedOnceRef.current ||
      !aiStatus.checked ||
      !aiStatus.reachable ||
      !aiStatus.aiConfigured ||
      analytics.totalQuestions === 0 ||
      analyzing
    ) {
      return;
    }
    const stale =
      !coachState.diagnosis || Date.now() - (coachState.diagnosis.generatedAt || 0) > 1000 * 60 * 60 * 6;
    if (stale) {
      autoAnalyzedOnceRef.current = true;
      void runDeepAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiStatus, analytics.totalQuestions]);

  const handleGenerateSectionQuiz = async (opts?: {
    mode?: 'remedial' | 'foundational_stage' | 'level_up';
    stage?: FoundationalStage;
  }) => {
    const mode = opts?.mode || 'remedial';
    const targetKey =
      (mode === 'foundational_stage' && coachState.activeFoundationalPlan?.sectionKey) ||
      activeSectionStat?.sectionKey ||
      selectedSectionKey ||
      'general';
    const targetTitle =
      (mode === 'foundational_stage' && coachState.activeFoundationalPlan?.sectionTitle) ||
      activeSectionTitle;
    const focusTopic =
      (mode === 'foundational_stage' && opts?.stage?.coreConcept) ||
      coachState.diagnosis?.weaknesses?.find((w) => w.sectionKey === targetKey)?.title ||
      targetTitle;

    if (opts?.stage) setGeneratingStageId(opts.stage.id);
    else setGeneratingQuiz(true);
    setQuizGenError(null);

    try {
      const created = await generateAndSaveSectionQuiz({
        uid: profile.uid,
        studentName: profile.fullNameQuad,
        sectionKey: targetKey,
        sectionTitle: targetTitle,
        focusTopic,
        questionCount: drillCount,
        mode,
        stageInfo: opts?.stage
          ? {
              order: opts.stage.order,
              title: opts.stage.title,
              objective: opts.stage.objective,
              coreConcept: opts.stage.coreConcept,
              sampleRule: opts.stage.sampleRule,
            }
          : null,
        analytics,
        memory: coachState.memory,
        quizzes,
      });

      setLastCreatedQuiz(created);

      // ربط معرف الاختبار بالمرحلة البنائية النشطة إذا كان اختبار مرحلة
      if (mode === 'foundational_stage' && opts?.stage && coachState.activeFoundationalPlan) {
        const nextPlan = {
          ...coachState.activeFoundationalPlan,
          updatedAt: Date.now(),
          stages: coachState.activeFoundationalPlan.stages.map((st) =>
            st.id === opts.stage!.id ? { ...st, quizId: created.id } : st
          ),
        };
        const nextState: CoachStateDoc = {
          ...coachState,
          activeFoundationalPlan: nextPlan,
          updatedAt: Date.now(),
        };
        setCoachState(nextState);
        await saveCoachStateToCloud(profile.uid, nextState);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setQuizGenError(
        msg === 'BACKEND_UNAVAILABLE'
          ? 'يلزم ربط خادم المنصة لتوليد اختبارات جديدة بالذكاء الاصطناعي.'
          : msg || 'تعذر إنشاء اختبار التقوية.'
      );
    } finally {
      setGeneratingQuiz(false);
      setGeneratingStageId(null);
    }
  };

  const handleActivateFoundationalPlan = async () => {
    const targetKey = activeSectionStat?.sectionKey || selectedSectionKey || 'general';
    const targetTitle = activeSectionTitle;
    const plan = buildFoundationalPlanFromDiagnosis(targetKey, targetTitle, coachState.diagnosis);
    const nextState: CoachStateDoc = {
      ...coachState,
      activeFoundationalPlan: plan,
      updatedAt: Date.now(),
    };
    setCoachState(nextState);
    await saveCoachStateToCloud(profile.uid, nextState);
  };

  const handleAdvanceToNextWeakSection = () => {
    const others = analytics.sectionStats.filter(
      (s) => s.sectionKey !== selectedSectionKey && s.strengthStatus !== 'strong'
    );
    const nextTarget = others[0] || analytics.sectionStats.find((s) => s.sectionKey !== selectedSectionKey);
    if (nextTarget) {
      setSelectedSectionKey(nextTarget.sectionKey);
      setLastCreatedQuiz(null);
    }
  };

  const scopedUnresolvedMistakes = useMemo(() => {
    if (mistakeScope === 'section' && activeSectionStat?.sectionKey) {
      const sub = analytics.unresolvedMistakes.filter(
        (m) => m.sectionKey === activeSectionStat.sectionKey
      );
      if (sub.length > 0) return sub;
    }
    return analytics.unresolvedMistakes;
  }, [analytics.unresolvedMistakes, mistakeScope, activeSectionStat]);

  const handleStartDirectMistakeReview = () => {
    setMistakeQuizError(null);
    const qs = buildDirectMistakeReviewQuestions(
      scopedUnresolvedMistakes,
      undefined,
      Math.min(5, scopedUnresolvedMistakes.length)
    );
    if (qs.length === 0) {
      setMistakeQuizError('لا توجد أخطاء معلقة حالياً للمراجعة.');
      return;
    }
    const label =
      mistakeScope === 'section' && activeSectionStat
        ? `تصحيح أخطاء: ${activeSectionStat.sectionTitle}`
        : 'تصحيح أخطائك الفعلية السابقة';
    onStartMistakesReview(qs, label);
  };

  const handleStartAiMistakeReview = async () => {
    if (generatingMistakeQuiz || scopedUnresolvedMistakes.length === 0) return;
    setGeneratingMistakeQuiz(true);
    setMistakeQuizError(null);
    try {
      const res = await generateAiMistakeReviewQuestions({
        studentName: profile.fullNameQuad,
        sectionKey: mistakeScope === 'section' ? activeSectionStat?.sectionKey : 'all',
        sectionTitle:
          mistakeScope === 'section' && activeSectionStat
            ? activeSectionStat.sectionTitle
            : 'بنك أخطائك الفعلية',
        questionCount: Math.min(5, scopedUnresolvedMistakes.length),
        analytics,
        memory: coachState.memory,
      });
      onStartMistakesReview(res.questions, res.title);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setMistakeQuizError(
        msg === 'BACKEND_UNAVAILABLE'
          ? 'يلزم اتصال بخادم الذكاء الاصطناعي — يمكنك بدء الاختبار المباشر من أخطائك فوراً بالزر المجاور.'
          : msg || 'تعذر تجهيز اختبار الأخطاء بالذكاء الاصطناعي.'
      );
    } finally {
      setGeneratingMistakeQuiz(false);
    }
  };

  const handleSendChat = async (opts?: { overrideText?: string; requestQuickQuiz?: boolean }) => {
    const rawText = (opts?.overrideText ?? chatInput).trim();
    if (!rawText || sendingChat) return;

    const userMsg: CoachChatMessage = {
      id: `u_${Date.now().toString(36)}`,
      role: 'user',
      text: rawText,
      createdAtMs: Date.now(),
    };

    const nextWithUser: CoachStateDoc = {
      ...coachState,
      chatMessages: [...coachState.chatMessages, userMsg].slice(-60),
      updatedAt: Date.now(),
    };
    setCoachState(nextWithUser);
    if (!opts?.overrideText) setChatInput('');
    setSendingChat(true);
    setChatError(null);

    window.setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);

    try {
      const res = await sendAiCoachChatMessage({
        studentName: profile.fullNameQuad,
        message: rawText,
        requestQuickQuiz: opts?.requestQuickQuiz,
        quickQuizTopic: activeSectionTitle,
        memory: coachState.memory,
        analytics,
        history: nextWithUser.chatMessages,
      });

      const assistantMsg: CoachChatMessage = {
        id: `a_${Date.now().toString(36)}`,
        role: 'assistant',
        text: res.reply,
        createdAtMs: Date.now(),
        ...(res.quickQuiz ? { quickQuiz: res.quickQuiz } : {}),
      };

      const finalState: CoachStateDoc = {
        ...nextWithUser,
        memory: res.memory,
        chatMessages: [...nextWithUser.chatMessages, assistantMsg].slice(-60),
        updatedAt: Date.now(),
      };
      setCoachState(finalState);
      await saveCoachStateToCloud(profile.uid, finalState);
      window.setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 80);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setChatError(
        msg === 'BACKEND_UNAVAILABLE'
          ? 'المحادثة المباشرة تحتاج اتصالاً بخادم المساعد الذكي.'
          : msg || 'تعذر إرسال الرسالة للمساعد الذكي.'
      );
    } finally {
      setSendingChat(false);
    }
  };

  const handleSaveCustomName = async () => {
    const clean = nameDraft.trim().slice(0, 60);
    const nextState: CoachStateDoc = {
      ...coachState,
      memory: {
        ...coachState.memory,
        studentPreferredName: clean || undefined,
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    };
    setCoachState(nextState);
    setEditingMemoryName(false);
    await saveCoachStateToCloud(profile.uid, nextState);
  };

  const chartSections = analytics.sectionStats.slice(0, 8);
  const sectionProgressEntry = activeSectionStat
    ? coachState.sectionProgress[activeSectionStat.sectionKey]
    : undefined;
  const activeSectionMastered =
    Boolean(sectionProgressEntry?.mastered) ||
    (activeSectionStat?.strengthStatus === 'strong' &&
      (sectionProgressEntry?.lastScorePct ?? 100) >= 95);

  const aiReady = aiStatus.reachable && aiStatus.aiConfigured;

  return (
    <div className="flex flex-col gap-5" dir="rtl">
      {/* 1. بطاقة الترحيب والملخص الذكي للمحفز الداعم */}
      <div className="rounded-3xl border-2 border-b-4 border-[#1899D6] bg-gradient-to-l from-[#DDF4FF] via-[#F4FBFF] to-white p-5 flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-12 h-12 rounded-2xl bg-[#1CB0F6] border-2 border-b-4 border-[#1899D6] text-white flex items-center justify-center shrink-0">
              <Brain className="w-6 h-6" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-black text-[#3C3C3C]">
                  أهلاً {preferredName} — مساعدك الذكي جاهز!
                </h3>
                <span className="text-xs font-extrabold text-[#1899D6]">
                  المحفز الداعم · ذاكرة مستمرة
                </span>
              </div>
              <p className="text-xs font-bold text-[#555555] mt-1 leading-relaxed max-w-2xl">
                {coachState.diagnosis?.summaryHeadline ||
                  (analytics.totalQuestions > 0
                    ? `حللت ${analytics.totalQuestions} سؤالاً بدقة إجمالية ${analytics.accuracyPct}% ومتوسط ${analytics.avgSecPerQ} ثانية/سؤال. نعمل الآن على تقوية نقطة محددة قسم بقسم دون تشتيت.`
                    : 'ابدأ أول اختبار لك وسأحلّل نقاط قوتك وأخطاءك وسرعتك لأصنع لك اختبارات تقوية مركزة من 5 أسئلة فقط.')}
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={analyzing || analytics.totalQuestions === 0 || !aiReady}
            onClick={() => void runDeepAnalysis()}
            className="duo-btn flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-[#1CB0F6] hover:bg-[#38BDF8] border-2 border-b-4 border-[#1899D6] text-white text-xs font-black cursor-pointer disabled:opacity-50"
          >
            {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            <span>{analyzing ? 'جاري التحليل الذكي...' : 'تحديث التحليل الشامل'}</span>
          </button>
        </div>

        {/* مؤشرات سريعة */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <div className="rounded-2xl bg-white border-2 border-[#E5E5E5] p-3">
            <span className="text-[11px] font-extrabold text-[#777777] flex items-center gap-1">
              <Target className="w-3.5 h-3.5 text-[#58CC02]" /> الدقة الإجمالية
            </span>
            <p className="text-xl font-black font-latin tabular-nums text-[#3C3C3C] mt-0.5">
              {analytics.accuracyPct}%
            </p>
          </div>
          <div className="rounded-2xl bg-white border-2 border-[#E5E5E5] p-3">
            <span className="text-[11px] font-extrabold text-[#777777] flex items-center gap-1">
              <Gauge className="w-3.5 h-3.5 text-[#1CB0F6]" /> متوسط السرعة
            </span>
            <p className="text-xl font-black font-latin tabular-nums text-[#3C3C3C] mt-0.5">
              {analytics.avgSecPerQ} <span className="text-xs font-cairo font-bold">ث/س</span>
            </p>
          </div>
          <div className="rounded-2xl bg-white border-2 border-[#E5E5E5] p-3">
            <span className="text-[11px] font-extrabold text-[#777777] flex items-center gap-1">
              <Compass className="w-3.5 h-3.5 text-[#A560E8]" /> القسم الأهم الآن
            </span>
            <p className="text-xs font-black text-[#6D28D9] mt-1 truncate">
              {activeSectionTitle}
            </p>
          </div>
          <div className="rounded-2xl bg-white border-2 border-[#E5E5E5] p-3">
            <span className="text-[11px] font-extrabold text-[#777777] flex items-center gap-1">
              <Award className="w-3.5 h-3.5 text-[#E5A400]" /> خطط البناء المنجزة
            </span>
            <p className="text-xl font-black font-latin tabular-nums text-[#3C3C3C] mt-0.5">
              {coachState.completedPlansCount}
            </p>
          </div>
        </div>

        {coachState.diagnosis?.encouragementNote && (
          <div className="rounded-2xl bg-white/90 border border-[#BCE3FA] px-3.5 py-2.5 flex items-start gap-2 text-xs font-bold text-[#0E6BA8]">
            <HeartHandshake className="w-4 h-4 shrink-0 mt-0.5" />
            <p>{coachState.diagnosis.encouragementNote}</p>
          </div>
        )}

        {aiStatus.checked && !aiReady && (
          <div className="rounded-2xl bg-[#FFF4CC] border border-[#FFC800] px-3.5 py-2.5 flex items-start gap-2 text-xs font-bold text-[#8A6500]">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              المساعد يعرض التحليل الإحصائي المحلي حالياً. لتفعيل توليد الاختبارات والمحادثة الذكية عبر هذا الموقع الثابت، اربط خادم المنصة في إعدادات النشر (`VITE_API_ORIGIN`).
            </span>
          </div>
        )}

        {analyzeError && (
          <div className="rounded-2xl bg-[#FFDFE0] border border-[#FF4B4B] px-3.5 py-2 text-xs font-bold text-[#EA2B2B]">
            {analyzeError}
          </div>
        )}
      </div>

      {/* 2. الرسوم والأعمدة البيانية التفاعلية */}
      {chartSections.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* أعمدة الإتقان حسب القسم */}
          <div className={`${card} p-4 lg:col-span-7 flex flex-col gap-3`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-black text-[#3C3C3C] flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-[#1CB0F6]" />
                <span>أعمدة الإتقان حسب القسم (اضغط على أي عمود لاختياره)</span>
              </h4>
              <div className="flex items-center gap-3 text-[10px] font-extrabold text-[#777777]">
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-[#58CC02] inline-block" /> قوي (85%+)
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-[#1CB0F6] inline-block" /> يتطور
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-[#FF4B4B] inline-block" /> يحتاج تقوية
                </span>
              </div>
            </div>

            <div className="relative pt-4 pb-1 px-2 rounded-2xl bg-[#FAFAFA] border border-[#EFEFEF]">
              {/* خط الهدف 85% */}
              <div
                className="pointer-events-none absolute left-3 right-3 border-t-2 border-dashed border-[#58CC02]/45 flex justify-end"
                style={{ bottom: 'calc(44px + 140px * 0.85)' }}
              >
                <span className="text-[10px] font-black font-latin text-[#46A302] bg-[#FAFAFA] px-1 -mt-2.5">
                  هدف الإتقان 85%
                </span>
              </div>

              <div className="grid grid-flow-col auto-cols-fr gap-2 sm:gap-3 items-end min-h-[195px]">
                {chartSections.map((sec) => {
                  const isSelected = sec.sectionKey === activeSectionStat?.sectionKey;
                  const barColor =
                    sec.strengthStatus === 'strong'
                      ? 'bg-[#58CC02] border-[#46A302]'
                      : sec.strengthStatus === 'developing'
                      ? 'bg-[#1CB0F6] border-[#1899D6]'
                      : 'bg-[#FF4B4B] border-[#EA2B2B]';
                  const barHeightPx = Math.max(14, Math.round((sec.accuracyPct / 100) * 140));
                  return (
                    <button
                      key={sec.sectionKey}
                      type="button"
                      onClick={() => setSelectedSectionKey(sec.sectionKey)}
                      className={`group flex flex-col items-center gap-1.5 cursor-pointer rounded-xl p-1 transition-colors ${
                        isSelected ? 'bg-[#DDF4FF]/70 ring-2 ring-[#1CB0F6]' : 'hover:bg-white'
                      }`}
                    >
                      <span className="text-[11px] font-black font-latin tabular-nums text-[#3C3C3C]">
                        {sec.accuracyPct}%
                      </span>
                      <div className="w-full max-w-[44px] h-[140px] flex items-end justify-center">
                        <div
                          className={`w-full rounded-t-xl border-2 border-b-0 transition-all ${barColor}`}
                          style={{ height: `${barHeightPx}px` }}
                        />
                      </div>
                      <span
                        title={sec.sectionTitle}
                        className="text-[10px] font-black text-[#555555] text-center line-clamp-2 leading-tight h-7 flex items-center"
                      >
                        {sec.sectionTitle}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* منحنى الدقة مقابل سرعة الحل */}
          <div className={`${card} p-4 lg:col-span-5 flex flex-col gap-3`}>
            <h4 className="text-sm font-black text-[#3C3C3C] flex items-center gap-2">
              <Clock className="w-4 h-4 text-[#A560E8]" />
              <span>مؤشر السرعة مقابل الدقة في الأقسام</span>
            </h4>
            <div className="flex flex-col gap-2.5 max-h-[235px] overflow-y-auto pr-0.5">
              {chartSections.map((sec) => {
                const speedWidth = Math.min(100, Math.max(12, Math.round((sec.avgSecPerQ / 90) * 100)));
                const speedBadge =
                  sec.speedStatus === 'fast'
                    ? 'text-[#46A302] bg-[#D7FFB8]'
                    : sec.speedStatus === 'slow'
                    ? 'text-[#8A6500] bg-[#FFF4CC]'
                    : 'text-[#1899D6] bg-[#DDF4FF]';
                const speedLabel =
                  sec.speedStatus === 'fast'
                    ? 'سريع'
                    : sec.speedStatus === 'slow'
                    ? 'يحتاج تسريع'
                    : 'متوازن';
                return (
                  <button
                    key={sec.sectionKey}
                    type="button"
                    onClick={() => setSelectedSectionKey(sec.sectionKey)}
                    className="w-full text-right rounded-2xl border border-[#E5E5E5] hover:border-[#1CB0F6] p-2.5 flex flex-col gap-1.5 cursor-pointer transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-black text-[#3C3C3C] truncate">
                        {sec.sectionTitle}
                      </span>
                      <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black shrink-0 ${speedBadge}`}>
                        {speedLabel} · <span className="font-latin tabular-nums">{sec.avgSecPerQ}ث</span>
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 items-center text-[10px] font-bold text-[#777777]">
                      <div>
                        <span>الدقة </span>
                        <span className="font-latin tabular-nums font-black text-[#3C3C3C]">
                          {sec.accuracyPct}%
                        </span>
                        <div className="h-2 rounded-full bg-[#EFEFEF] overflow-hidden mt-0.5">
                          <div
                            className={`h-full rounded-full ${
                              sec.accuracyPct >= 85
                                ? 'bg-[#58CC02]'
                                : sec.accuracyPct >= 65
                                ? 'bg-[#1CB0F6]'
                                : 'bg-[#FF4B4B]'
                            }`}
                            style={{ width: `${sec.accuracyPct}%` }}
                          />
                        </div>
                      </div>
                      <div>
                        <span>الزمن/سؤال </span>
                        <span className="font-latin tabular-nums font-black text-[#3C3C3C]">
                          {sec.avgSecPerQ}ث
                        </span>
                        <div className="h-2 rounded-full bg-[#EFEFEF] overflow-hidden mt-0.5">
                          <div
                            className={`h-full rounded-full ${
                              sec.speedStatus === 'slow' ? 'bg-[#FFC800]' : 'bg-[#A560E8]'
                            }`}
                            style={{ width: `${speedWidth}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 3. تشخيص القوة والأخطاء والبطء */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        {/* القوة */}
        <div className="rounded-3xl border-2 border-b-4 border-[#58CC02]/45 bg-[#F6FFED] p-4 flex flex-col gap-2.5">
          <div className="flex items-center gap-2 text-[#46A302] font-black text-sm">
            <TrendingUp className="w-4 h-4" />
            <span>نقاط القوة («قوي في»)</span>
          </div>
          {coachState.diagnosis?.strengths?.length ? (
            coachState.diagnosis.strengths.slice(0, 3).map((st, idx) => (
              <div key={idx} className="rounded-2xl bg-white border border-[#B8F28B] p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-black text-[#3C3C3C]">{st.title}</span>
                  <span className="text-xs font-black font-latin tabular-nums text-[#46A302]">
                    {st.accuracyPct}%
                  </span>
                </div>
                <p className="text-[11px] font-bold text-[#555555] mt-1">{st.detail}</p>
              </div>
            ))
          ) : analytics.strongSections.length > 0 ? (
            analytics.strongSections.slice(0, 3).map((s) => (
              <div key={s.sectionKey} className="rounded-2xl bg-white border border-[#B8F28B] p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-black text-[#3C3C3C]">{s.sectionTitle}</span>
                  <span className="text-xs font-black font-latin tabular-nums text-[#46A302]">
                    {s.accuracyPct}%
                  </span>
                </div>
                <p className="text-[11px] font-bold text-[#555555] mt-1">
                  أجبت {s.correctCount} من أصل {s.totalQuestions} سؤال بشكل صحيح.
                </p>
              </div>
            ))
          ) : (
            <p className="text-xs font-bold text-[#555555]">
              أكمل مزيداً من الاختبارات لتتضح أقوى مهاراتك هنا.
            </p>
          )}
        </div>

        {/* الأخطاء */}
        <div className="rounded-3xl border-2 border-b-4 border-[#FF4B4B]/45 bg-[#FFF5F5] p-4 flex flex-col gap-2.5">
          <div className="flex items-center gap-2 text-[#EA2B2B] font-black text-sm">
            <AlertTriangle className="w-4 h-4" />
            <span>مواضع الأخطاء («تخطئ في»)</span>
          </div>
          {coachState.diagnosis?.weaknesses?.length ? (
            coachState.diagnosis.weaknesses.slice(0, 3).map((wk, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => wk.sectionKey && setSelectedSectionKey(wk.sectionKey)}
                className="text-right rounded-2xl bg-white border border-[#FFC1C1] hover:border-[#FF4B4B] p-2.5 cursor-pointer transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-black text-[#3C3C3C]">{wk.title}</span>
                  <span className="text-xs font-black font-latin tabular-nums text-[#EA2B2B]">
                    {wk.accuracyPct}%
                  </span>
                </div>
                <p className="text-[11px] font-bold text-[#555555] mt-1">{wk.detail}</p>
              </button>
            ))
          ) : analytics.weakSections.length > 0 ? (
            analytics.weakSections.slice(0, 3).map((s) => (
              <button
                key={s.sectionKey}
                type="button"
                onClick={() => setSelectedSectionKey(s.sectionKey)}
                className="text-right rounded-2xl bg-white border border-[#FFC1C1] hover:border-[#FF4B4B] p-2.5 cursor-pointer transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-black text-[#3C3C3C]">{s.sectionTitle}</span>
                  <span className="text-xs font-black font-latin tabular-nums text-[#EA2B2B]">
                    {s.accuracyPct}%
                  </span>
                </div>
                <p className="text-[11px] font-bold text-[#555555] mt-1">
                  {s.wrongCount} أخطاء من أصل {s.totalQuestions} سؤال — اضغط لتقوية هذا القسم.
                </p>
              </button>
            ))
          ) : (
            <p className="text-xs font-bold text-[#555555]">
              ممتاز! لم تُسجّل نقاط ضعف واضحة حتى الآن.
            </p>
          )}
        </div>

        {/* التبطئة */}
        <div className="rounded-3xl border-2 border-b-4 border-[#FFC800]/65 bg-[#FFFDF0] p-4 flex flex-col gap-2.5">
          <div className="flex items-center gap-2 text-[#9A6B00] font-black text-sm">
            <Clock className="w-4 h-4" />
            <span>مواضع التبطئة («تبطئ في»)</span>
          </div>
          {coachState.diagnosis?.slowAreas?.length ? (
            coachState.diagnosis.slowAreas.slice(0, 3).map((sl, idx) => (
              <div key={idx} className="rounded-2xl bg-white border border-[#FFE58F] p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-black text-[#3C3C3C]">{sl.title}</span>
                  <span className="text-xs font-black font-latin tabular-nums text-[#9A6B00]">
                    {sl.avgSecPerQ}ث/س
                  </span>
                </div>
                <p className="text-[11px] font-bold text-[#555555] mt-1">{sl.advice}</p>
              </div>
            ))
          ) : analytics.slowSections.length > 0 ? (
            analytics.slowSections.slice(0, 3).map((s) => (
              <div key={s.sectionKey} className="rounded-2xl bg-white border border-[#FFE58F] p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-black text-[#3C3C3C]">{s.sectionTitle}</span>
                  <span className="text-xs font-black font-latin tabular-nums text-[#9A6B00]">
                    {s.avgSecPerQ}ث/س
                  </span>
                </div>
                <p className="text-[11px] font-bold text-[#555555] mt-1">
                  يستغرق وقتاً أطول من المعدل — نركز فيه على طرق الحل السريع والاستبعاد.
                </p>
              </div>
            ))
          ) : (
            <p className="text-xs font-bold text-[#555555]">
              سرعتك متوازنة جداً حتى الآن! حافظ على إيقاعك السريع.
            </p>
          )}
        </div>
      </div>

      {/* 3.5. بنك تصحيح الأخطاء الفعلية من اختباراتك الذاتية */}
      {(analytics.unresolvedMistakes.length > 0 || analytics.correctedMistakesCount > 0) && (
        <div className="rounded-3xl border-2 border-b-4 border-[#FF4B4B]/70 bg-gradient-to-l from-[#FFF5F5] via-white to-[#FFFDF8] p-5 flex flex-col gap-3.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <div className="w-10 h-10 rounded-2xl bg-[#FF4B4B] border-b-4 border-[#EA2B2B] text-white flex items-center justify-center shrink-0">
                <RotateCcw className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-base font-black text-[#3C3C3C]">
                  بنك تصحيح أخطائك الفعلية (من اختباراتك الذاتية)
                </h4>
                <p className="text-xs font-bold text-[#666666] leading-relaxed">
                  يستخرج المساعد الأسئلة التي أخطأت فيها سابقاً؛ وأي سؤال تحله هنا بشكل صحيح يُحذف من أخطائك وينقص من عدد الأخطاء ويُحتسب إجابةً صحيحة تلقائياً في إحصائياتك ولوحة الشرف.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs font-black shrink-0">
              <span className="px-3 py-1.5 rounded-xl bg-[#FFDFE0] border border-[#FF4B4B]/50 text-[#C81E1E]">
                معلّق: <span className="font-latin tabular-nums">{analytics.unresolvedMistakes.length}</span>
              </span>
              <span className="px-3 py-1.5 rounded-xl bg-[#D7FFB8] border border-[#58CC02]/60 text-[#2F6F00]">
                مصحّح ✓: <span className="font-latin tabular-nums">{analytics.correctedMistakesCount}</span>
              </span>
            </div>
          </div>

          {analytics.unresolvedMistakes.length === 0 ? (
            <div className="rounded-2xl bg-[#F6FFED] border-2 border-[#58CC02] p-3.5 flex items-center gap-2.5 text-xs font-black text-[#2F6F00]">
              <ShieldCheck className="w-5 h-5 text-[#46A302] shrink-0" />
              <span>
                أحسنت يا {preferredName}! تم تصحيح جميع أخطائك السابقة ({analytics.correctedMistakesCount}) وتحويلها إلى إجابات صحيحة في سجلك ولوحة الشرف.
              </span>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex rounded-xl border border-[#E5E5E5] bg-[#F7F7F7] p-1 text-xs font-black">
                  <button
                    type="button"
                    onClick={() => setMistakeScope('all')}
                    className={`px-3 py-1.5 rounded-lg cursor-pointer transition-colors ${
                      mistakeScope === 'all'
                        ? 'bg-white text-[#EA2B2B] shadow-xs'
                        : 'text-[#666666] hover:text-[#3C3C3C]'
                    }`}
                  >
                    كل الأخطاء ({analytics.unresolvedMistakes.length})
                  </button>
                  {activeSectionStat && (
                    <button
                      type="button"
                      onClick={() => setMistakeScope('section')}
                      className={`px-3 py-1.5 rounded-lg cursor-pointer transition-colors ${
                        mistakeScope === 'section'
                          ? 'bg-white text-[#EA2B2B] shadow-xs'
                          : 'text-[#666666] hover:text-[#3C3C3C]'
                      }`}
                    >
                      قسم «{activeSectionStat.sectionTitle}» (
                      {
                        analytics.unresolvedMistakes.filter(
                          (m) => m.sectionKey === activeSectionStat.sectionKey
                        ).length
                      }
                      )
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleStartDirectMistakeReview}
                    className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer"
                  >
                    <Play className="w-4 h-4" />
                    <span>
                      ابدأ اختبار تصحيح أخطائك الآن ({Math.min(5, scopedUnresolvedMistakes.length)}{' '}
                      أسئلة)
                    </span>
                  </button>

                  {aiReady && (
                    <button
                      type="button"
                      disabled={generatingMistakeQuiz}
                      onClick={() => void handleStartAiMistakeReview()}
                      className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-[#A560E8] hover:bg-[#B477EE] border-2 border-b-4 border-[#8938D6] text-white text-xs font-black cursor-pointer disabled:opacity-50"
                    >
                      {generatingMistakeQuiz ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Sparkles className="w-4 h-4" />
                      )}
                      <span>
                        {generatingMistakeQuiz
                          ? 'جاري تجهيز شرح الأخطاء بالذكاء الاصطناعي...'
                          : 'توليد بالذكاء الاصطناعي مع شرح مخصص (5)'}
                      </span>
                    </button>
                  )}
                </div>
              </div>

              {mistakeQuizError && (
                <div className="rounded-2xl bg-[#FFDFE0] border border-[#FF4B4B] px-3 py-2 text-xs font-bold text-[#EA2B2B]">
                  {mistakeQuizError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {scopedUnresolvedMistakes.slice(0, 4).map((m) => (
                  <div
                    key={m.fp}
                    className="rounded-2xl bg-white border border-[#FFD6D6] p-3 flex flex-col gap-1"
                  >
                    <div className="flex items-center justify-between gap-2 text-[10px] font-black">
                      <span className="text-[#EA2B2B] truncate">{m.sectionTitle}</span>
                      {m.mistakeCount > 1 && (
                        <span className="px-2 py-0.5 rounded-lg bg-[#FFF4CC] text-[#9A6B00] shrink-0">
                          تكرر {m.mistakeCount} مرات
                        </span>
                      )}
                    </div>
                    <div className="text-xs font-black text-[#3C3C3C] line-clamp-2 leading-relaxed">
                      <MathText text={m.question.text} inline />
                    </div>
                    <div className="text-[11px] font-bold text-[#777777] truncate">
                      إجابتك السابقة:{' '}
                      <span className="text-[#EA2B2B]">
                        <MathText text={m.chosenAnswerText} inline />
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* 4. منشئ اختبارات التقوية المتدرجة قسم بقسم (الافتراضي: 5 أسئلة) */}
      <div className="rounded-3xl border-2 border-b-4 border-[#A560E8] bg-gradient-to-l from-[#FAF5FF] to-white p-5 flex flex-col gap-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <div className="w-10 h-10 rounded-2xl bg-[#A560E8] border-b-4 border-[#8938D6] text-white flex items-center justify-center shrink-0">
              <Dumbbell className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-base font-black text-[#3C3C3C]">
                اختبار تقوية مركّز للقسم ({activeSectionTitle})
              </h4>
              <p className="text-xs font-bold text-[#666666]">
                يُنشئ الاختبار تحت قسمه مباشرة بأسئلة مدروسة ورسوم وجداول وقوانين وشرح مفصل — 5 أسئلة مركزة بدون إثقال.
              </p>
            </div>
          </div>

          {activeSectionMastered && (
            <button
              type="button"
              onClick={handleAdvanceToNextWeakSection}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl bg-[#D7FFB8] border-2 border-[#58CC02] text-[#46A302] text-xs font-black cursor-pointer"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>أحسنت! أتقنت هذا القسم · انتقل للقسم التالي</span>
              <ArrowUpRight className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {analytics.sectionStats.length > 0 && (
            <label className="flex items-center gap-2 text-xs font-black text-[#3C3C3C]">
              <span>القسم المستهدف:</span>
              <select
                value={selectedSectionKey}
                onChange={(e) => {
                  setSelectedSectionKey(e.target.value);
                  setLastCreatedQuiz(null);
                }}
                className="px-3 py-2 rounded-xl border-2 border-[#E2D4F8] bg-white text-xs font-black outline-none"
              >
                {analytics.sectionStats.map((sec) => (
                  <option key={sec.sectionKey} value={sec.sectionKey}>
                    {sec.sectionTitle} ({sec.accuracyPct}%)
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="flex items-center gap-1.5 text-xs font-black text-[#3C3C3C]">
            <span>عدد الأسئلة:</span>
            {[3, 5, 8, 10].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setDrillCount(n)}
                className={`px-3 py-1.5 rounded-xl border-2 text-xs font-black font-latin cursor-pointer ${
                  drillCount === n
                    ? 'bg-[#A560E8] border-[#8938D6] text-white'
                    : 'bg-white border-[#E5E5E5] text-[#555555]'
                }`}
              >
                {n}{n === 5 ? ' (المعتاد)' : ''}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={generatingQuiz || !aiReady}
            onClick={() => void handleGenerateSectionQuiz({ mode: 'remedial' })}
            className="duo-btn flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#A560E8] hover:bg-[#B477EE] border-2 border-b-4 border-[#8938D6] text-white text-sm font-black cursor-pointer disabled:opacity-50"
          >
            {generatingQuiz ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            <span>
              {generatingQuiz
                ? `جاري تصميم ${drillCount} أسئلة لهذا القسم...`
                : `أنشئ اختبار تقوية ذكي (${drillCount} أسئلة)`}
            </span>
          </button>

          {(!coachState.activeFoundationalPlan ||
            coachState.activeFoundationalPlan.sectionKey !== (activeSectionStat?.sectionKey || selectedSectionKey)) && (
            <button
              type="button"
              onClick={() => void handleActivateFoundationalPlan()}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-white border-2 border-[#E2D4F8] hover:border-[#A560E8] text-xs font-black text-[#6D28D9] cursor-pointer"
            >
              <Layers className="w-4 h-4" />
              <span>ابدأ خطة «تقويم المهارات البنائية» لهذا القسم</span>
            </button>
          )}
        </div>

        {quizGenError && (
          <div className="rounded-2xl bg-[#FFDFE0] border border-[#FF4B4B] px-3.5 py-2 text-xs font-bold text-[#EA2B2B]">
            {quizGenError}
          </div>
        )}

        {lastCreatedQuiz && (
          <div className="rounded-2xl bg-[#D7FFB8]/65 border-2 border-[#58CC02] p-3.5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-black text-[#2F6F00]">
                جاهز: {lastCreatedQuiz.title}
              </p>
              <p className="text-[11px] font-bold text-[#46A302]">
                تم حفظه ({lastCreatedQuiz.questionCount} أسئلة) تحت قسم «{activeSectionTitle}» في قائمتك.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onStartQuiz(lastCreatedQuiz)}
              className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer"
            >
              <Play className="w-4 h-4" /> ابدأ الاختبار الآن
            </button>
          </div>
        )}
      </div>

      {/* 5. خطة تقويم المهارات البنائية (عند الحاجة أو عند تكرار الأخطاء) */}
      {(coachState.activeFoundationalPlan || analytics.sectionNeedsFoundationalPlan) && (
        <div className="rounded-3xl border-2 border-b-4 border-[#F59E0B] bg-gradient-to-l from-[#FFFBEB] to-white p-5 flex flex-col gap-3.5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex items-start gap-2.5">
              <div className="w-10 h-10 rounded-2xl bg-[#F59E0B] border-b-4 border-[#D97706] text-white flex items-center justify-center shrink-0">
                <Flame className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-base font-black text-[#3C3C3C]">
                  خطة «تقويم المهارات البنائية»
                  {coachState.activeFoundationalPlan
                    ? `: ${coachState.activeFoundationalPlan.sectionTitle}`
                    : analytics.sectionNeedsFoundationalPlan
                    ? `: ${analytics.sectionNeedsFoundationalPlan.sectionTitle}`
                    : ''}
                </h4>
                <p className="text-xs font-bold text-[#92400E]">
                  {coachState.activeFoundationalPlan?.reason ||
                    'لاحظنا تكرار الأخطاء في هذا القسم، لذلك سنبني الأساس من البداية مرحلة بمرحلة حتى تتقنه تماماً.'}
                </p>
              </div>
            </div>

            {!coachState.activeFoundationalPlan && (
              <button
                type="button"
                onClick={() => void handleActivateFoundationalPlan()}
                className="duo-btn px-4 py-2 rounded-2xl bg-[#F59E0B] border-2 border-b-4 border-[#D97706] text-white text-xs font-black cursor-pointer"
              >
                اعتماد خطة البناء الآن
              </button>
            )}
          </div>

          {coachState.activeFoundationalPlan && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {coachState.activeFoundationalPlan.stages.map((st) => {
                const isDone = st.status === 'completed';
                const isActive = st.status === 'active';
                const quizObj = st.quizId ? quizzes.find((q) => q.id === st.quizId) : undefined;
                return (
                  <div
                    key={st.id}
                    className={`rounded-2xl border-2 p-3.5 flex flex-col justify-between gap-2.5 ${
                      isDone
                        ? 'border-[#58CC02] bg-[#F6FFED]'
                        : isActive
                        ? 'border-[#F59E0B] bg-white shadow-xs'
                        : 'border-[#E5E5E5] bg-[#F7F7F7] opacity-80'
                    }`}
                  >
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-black text-[#3C3C3C] flex items-center gap-1.5">
                          {isDone ? (
                            <CheckCircle2 className="w-4 h-4 text-[#46A302]" />
                          ) : isActive ? (
                            <Zap className="w-4 h-4 text-[#D97706]" />
                          ) : (
                            <Lock className="w-3.5 h-3.5 text-[#777777]" />
                          )}
                          <span>المرحلة {st.order}</span>
                        </span>
                        <span className="text-[11px] font-black font-latin tabular-nums text-[#777777]">
                          الهدف {st.targetScorePct}%
                          {typeof st.bestScorePct === 'number' ? ` · أفضل ${st.bestScorePct}%` : ''}
                        </span>
                      </div>
                      <h5 className="text-xs font-black text-[#3C3C3C]">{st.title}</h5>
                      <p className="text-[11px] font-bold text-[#555555] leading-relaxed">
                        {st.objective}
                      </p>
                      <div className="rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] p-2 text-[10px] font-bold text-[#475569]">
                        القاعدة: {st.sampleRule}
                      </div>
                    </div>

                    {isActive && (
                      <div className="flex flex-wrap gap-1.5">
                        {quizObj ? (
                          <button
                            type="button"
                            onClick={() => onStartQuiz(quizObj)}
                            className="duo-btn w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer"
                          >
                            <Play className="w-3.5 h-3.5" /> حل اختبار المرحلة الآن
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={generatingStageId === st.id || !aiReady}
                            onClick={() =>
                              void handleGenerateSectionQuiz({
                                mode: 'foundational_stage',
                                stage: st,
                              })
                            }
                            className="duo-btn w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-[#F59E0B] border-2 border-b-4 border-[#D97706] text-white text-xs font-black cursor-pointer disabled:opacity-50"
                          >
                            {generatingStageId === st.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Sparkles className="w-3.5 h-3.5" />
                            )}
                            <span>
                              {generatingStageId === st.id
                                ? 'جاري التحضير...'
                                : 'أنشئ اختبار المرحلة (5 أسئلة)'}
                            </span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 6. دردشة المحفز الداعم + ذاكرة الطالب + الاختبار السريع داخل المحادثة */}
      <div className={`${card} p-5 flex flex-col gap-3.5`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-2xl bg-[#58CC02] border-b-4 border-[#46A302] text-white flex items-center justify-center shrink-0">
              <MessageCircle className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-base font-black text-[#3C3C3C]">
                سولف مع مساعدك الذكي («المحفز الداعم»)
              </h4>
              <p className="text-[11px] font-bold text-[#777777]">
                يحفظ اسمك وشخصيتك وأهدافك، ويشجعك، ويقدر يسوي لك اختباراً سريعاً من 5 أسئلة بنص المحادثة!
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {editingMemoryName ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="الاسم المفضل..."
                  className="px-2.5 py-1 rounded-xl border-2 border-[#1CB0F6] text-xs font-bold outline-none w-32"
                />
                <button
                  type="button"
                  onClick={() => void handleSaveCustomName()}
                  className="px-2.5 py-1 rounded-xl bg-[#58CC02] text-white text-xs font-black cursor-pointer"
                >
                  حفظ
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setNameDraft(coachState.memory.studentPreferredName || '');
                  setEditingMemoryName(true);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#F7F7F7] border border-[#E5E5E5] hover:border-[#1CB0F6] text-xs font-black text-[#555555] cursor-pointer"
              >
                <UserCheck className="w-3.5 h-3.5 text-[#1899D6]" />
                <span>الاسم المحفوظ: {preferredName}</span>
              </button>
            )}
          </div>
        </div>

        {(coachState.memory.personalityNotes.length > 0 ||
          coachState.memory.learningGoals.length > 0 ||
          coachState.memory.customFacts.length > 0) && (
          <div className="rounded-2xl bg-[#F8FAFC] border border-[#E2E8F0] px-3 py-2 text-[11px] font-bold text-[#475569] flex flex-wrap gap-x-4 gap-y-1">
            {coachState.memory.learningGoals.slice(-2).map((g, i) => (
              <span key={`g_${i}`}>الهدف: {g}</span>
            ))}
            {coachState.memory.personalityNotes.slice(-2).map((p, i) => (
              <span key={`p_${i}`}>ملاحظة: {p}</span>
            ))}
            {coachState.memory.customFacts.slice(-2).map((f, i) => (
              <span key={`f_${i}`}>معلومة: {f}</span>
            ))}
          </div>
        )}

        {/* سجل الرسائل */}
        <div className="rounded-2xl border-2 border-[#EFEFEF] bg-[#FAFAFA] p-3.5 max-h-[380px] overflow-y-auto flex flex-col gap-3">
          {coachState.chatMessages.length === 0 ? (
            <div className="py-6 text-center flex flex-col items-center gap-2 text-[#777777]">
              <Bot className="w-8 h-8 text-[#58CC02]" />
              <p className="text-xs font-black text-[#3C3C3C]">
                قل لي اسمك أو اسألني عن أي سؤال أخطأت فيه، أو اطلب اختباراً سريعاً لقياس مستواك!
              </p>
              <div className="flex flex-wrap justify-center gap-2 mt-1">
                {[
                  'مرحباً! نادني بالاسم الذي أحبه وذكّرني بخطتي',
                  'وش أهم نقطة أخطئ فيها وكيف أصلحها؟',
                  analytics.unresolvedMistakes.length > 0
                    ? 'اختبرني بـ 5 أسئلة من أخطائي السابقة لأصححها!'
                    : 'اختبر مستواي باختبار سريع من 5 أسئلة الآن!',
                ].map((promptTxt, idx) => (
                  <button
                    key={idx}
                    type="button"
                    disabled={!aiReady || sendingChat}
                    onClick={() =>
                      void handleSendChat({
                        overrideText: promptTxt,
                        requestQuickQuiz: idx === 2,
                      })
                    }
                    className="px-3 py-1.5 rounded-xl bg-white border border-[#E5E5E5] hover:border-[#1CB0F6] text-[11px] font-black text-[#3C3C3C] cursor-pointer disabled:opacity-50"
                  >
                    {promptTxt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            coachState.chatMessages.map((msg) => {
              const isUser = msg.role === 'user';
              return (
                <div
                  key={msg.id}
                  className={`flex flex-col gap-1.5 ${isUser ? 'items-start' : 'items-end'}`}
                >
                  <div
                    className={`max-w-[90%] sm:max-w-[80%] rounded-2xl px-3.5 py-2.5 text-xs font-bold leading-relaxed whitespace-pre-wrap ${
                      isUser
                        ? 'bg-[#DDF4FF] border border-[#1CB0F6]/50 text-[#0E4A6F]'
                        : 'bg-white border-2 border-[#E5E5E5] text-[#3C3C3C]'
                    }`}
                  >
                    <MathText text={msg.text} />

                    {msg.quickQuiz && (
                      <div className="mt-3 rounded-2xl border-2 border-[#A560E8] bg-[#FAF5FF] p-3 flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-black text-[#6D28D9] flex items-center gap-1.5">
                            <Zap className="w-4 h-4" />
                            <span>{msg.quickQuiz.title}</span>
                          </span>
                          <span className="text-[11px] font-black font-latin text-[#8938D6]">
                            {msg.quickQuiz.questions.length} أسئلة
                          </span>
                        </div>
                        {typeof msg.quickQuiz.completedScore === 'number' ? (
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-black text-[#46A302] bg-[#D7FFB8]/70 rounded-xl px-2.5 py-1.5">
                            <span>
                              أنهيت هذا الاختبار السريع: {msg.quickQuiz.completedScore}/
                              {msg.quickQuiz.completedTotal}
                            </span>
                            <button
                              type="button"
                              onClick={() => onStartQuickQuiz(msg.quickQuiz!, msg.id)}
                              className="underline cursor-pointer"
                            >
                              إعادة المحاولة
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onStartQuickQuiz(msg.quickQuiz!, msg.id)}
                            className="duo-btn flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-[#A560E8] border-2 border-b-4 border-[#8938D6] text-white text-xs font-black cursor-pointer"
                          >
                            <Play className="w-3.5 h-3.5" /> ابدأ الاختبار السريع داخل المحادثة
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
          {sendingChat && (
            <div className="flex items-center gap-2 text-xs font-bold text-[#777777] self-end bg-white border border-[#E5E5E5] rounded-2xl px-3 py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1CB0F6]" />
              <span>المساعد الذكي يكتب الرد...</span>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {chatError && (
          <div className="rounded-2xl bg-[#FFDFE0] border border-[#FF4B4B] px-3 py-2 text-xs font-bold text-[#EA2B2B]">
            {chatError}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSendChat();
              }
            }}
            placeholder="اكتب للمساعد الذكي... (مثلاً: اسمي أحمد، اشرح لي النسبة المئوية أو اختبرني)"
            className="flex-1 rounded-2xl border-2 border-[#E5E5E5] focus:border-[#1CB0F6] outline-none px-4 py-2.5 text-xs font-bold text-[#3C3C3C] bg-white"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!aiReady || sendingChat}
              onClick={() =>
                void handleSendChat({
                  overrideText:
                    chatInput.trim() ||
                    (analytics.unresolvedMistakes.length > 0
                      ? 'اعمل لي اختباراً سريعاً من 5 أسئلة من أخطائي السابقة لتصحيحها'
                      : `اعمل لي اختباراً سريعاً من 5 أسئلة تقيس فيه مستواي في: ${activeSectionTitle}`),
                  requestQuickQuiz: true,
                })
              }
              title={
                analytics.unresolvedMistakes.length > 0
                  ? 'اختبار سريع من أخطائك السابقة داخل المحادثة'
                  : 'إنشاء اختبار سريع 5 أسئلة في المحادثة'
              }
              className="duo-btn flex items-center gap-1.5 px-3.5 py-2.5 rounded-2xl bg-[#A560E8] border-2 border-b-4 border-[#8938D6] text-white text-xs font-black cursor-pointer disabled:opacity-50 shrink-0"
            >
              <Zap className="w-4 h-4" />
              <span>
                {analytics.unresolvedMistakes.length > 0 ? 'اختبار أخطائي (5)' : 'اختبار سريع (5)'}
              </span>
            </button>
            <button
              type="button"
              disabled={!chatInput.trim() || !aiReady || sendingChat}
              onClick={() => void handleSendChat()}
              className="duo-btn flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer disabled:opacity-50 shrink-0"
            >
              <Send className="w-4 h-4" />
              <span>إرسال</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
