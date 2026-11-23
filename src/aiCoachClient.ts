import { doc, onSnapshot, setDoc } from './firestoreTracked';
import { isBackendServerDetected, resolveApiUrl } from './apiBase';
import { activeFirebaseConfig, auth, db } from './firebase';
import { createMyQuizzesAutoSplit, parseQuizBundleJson } from './myQuizzes';
import type {
  CoachChatMessage,
  CoachDiagnosisResult,
  CoachMemory,
  CoachQuickQuiz,
  CoachSectionProgress,
  CoachStateDoc,
  FoundationalPlan,
  MyQuiz,
  QuizQuestion,
} from './types';
import type { LocalAnalyticsSummary } from './aiCoachAnalytics';

const LOCAL_COACH_STATE_PREFIX = 'duoboard_ai_coach_state_v1_';

export function createEmptyCoachState(uid: string): CoachStateDoc {
  return {
    id: 'state',
    ownerId: uid,
    memory: {
      personalityNotes: [],
      learningGoals: [],
      weakFocusHistory: [],
      customFacts: [],
      updatedAt: 0,
    },
    diagnosis: null,
    activeFoundationalPlan: null,
    completedPlansCount: 0,
    sectionProgress: {},
    chatMessages: [],
    updatedAt: 0,
  };
}

export function loadLocalCoachState(uid: string): CoachStateDoc {
  if (typeof window === 'undefined') return createEmptyCoachState(uid);
  try {
    const raw = localStorage.getItem(`${LOCAL_COACH_STATE_PREFIX}${uid}`);
    if (!raw) return createEmptyCoachState(uid);
    const parsed = JSON.parse(raw) as Partial<CoachStateDoc>;
    const base = createEmptyCoachState(uid);
    return {
      ...base,
      ...parsed,
      id: 'state',
      ownerId: uid,
      memory: {
        ...base.memory,
        ...(parsed.memory || {}),
        personalityNotes: Array.isArray(parsed.memory?.personalityNotes)
          ? parsed.memory.personalityNotes
          : [],
        learningGoals: Array.isArray(parsed.memory?.learningGoals)
          ? parsed.memory.learningGoals
          : [],
        weakFocusHistory: Array.isArray(parsed.memory?.weakFocusHistory)
          ? parsed.memory.weakFocusHistory
          : [],
        customFacts: Array.isArray(parsed.memory?.customFacts) ? parsed.memory.customFacts : [],
      },
      sectionProgress:
        parsed.sectionProgress && typeof parsed.sectionProgress === 'object'
          ? parsed.sectionProgress
          : {},
      chatMessages: Array.isArray(parsed.chatMessages) ? parsed.chatMessages.slice(-80) : [],
    };
  } catch {
    return createEmptyCoachState(uid);
  }
}

export function saveLocalCoachState(uid: string, state: CoachStateDoc): void {
  if (typeof window === 'undefined') return;
  try {
    const trimmed: CoachStateDoc = {
      ...state,
      id: 'state',
      ownerId: uid,
      chatMessages: state.chatMessages.slice(-80),
      updatedAt: state.updatedAt || Date.now(),
    };
    localStorage.setItem(`${LOCAL_COACH_STATE_PREFIX}${uid}`, JSON.stringify(trimmed));
  } catch {
    // Ignore storage quota errors
  }
}

export async function saveCoachStateToCloud(uid: string, state: CoachStateDoc): Promise<void> {
  const clean: CoachStateDoc = {
    id: 'state',
    ownerId: uid,
    memory: {
      ...(state.memory.studentPreferredName
        ? { studentPreferredName: state.memory.studentPreferredName }
        : {}),
      personalityNotes: state.memory.personalityNotes.slice(-15),
      learningGoals: state.memory.learningGoals.slice(-15),
      weakFocusHistory: state.memory.weakFocusHistory.slice(-15),
      customFacts: state.memory.customFacts.slice(-15),
      updatedAt: state.memory.updatedAt || Date.now(),
    },
    diagnosis: state.diagnosis || null,
    activeFoundationalPlan: state.activeFoundationalPlan || null,
    completedPlansCount: Math.max(0, Number(state.completedPlansCount) || 0),
    sectionProgress: state.sectionProgress || {},
    chatMessages: (state.chatMessages || []).slice(-60),
    updatedAt: Date.now(),
  };

  saveLocalCoachState(uid, clean);

  try {
    await setDoc(doc(db, 'users', uid, 'aiCoach', 'state'), clean);
  } catch {
    // Offline or Firestore rules pending — local cache already updated
  }
}

export function subscribeCoachState(
  uid: string,
  onChange: (state: CoachStateDoc) => void
): () => void {
  const local = loadLocalCoachState(uid);
  onChange(local);

  return onSnapshot(
    doc(db, 'users', uid, 'aiCoach', 'state'),
    (snap) => {
      if (!snap.exists()) return;
      const remote = snap.data() as CoachStateDoc;
      if (!remote || remote.ownerId !== uid) return;
      const currentLocal = loadLocalCoachState(uid);
      if ((remote.updatedAt || 0) >= (currentLocal.updatedAt || 0)) {
        const merged: CoachStateDoc = {
          ...createEmptyCoachState(uid),
          ...remote,
          id: 'state',
          ownerId: uid,
        };
        saveLocalCoachState(uid, merged);
        onChange(merged);
      }
    },
    () => {
      // Keep local snapshot if offline
    }
  );
}

async function callAiEndpoint<T>(path: string, body: Record<string, unknown>, timeoutMs = 45000): Promise<T> {
  if (!isBackendServerDetected()) {
    throw new Error('BACKEND_UNAVAILABLE');
  }
  const user = auth.currentUser;
  if (!user) {
    throw new Error('يلزم تسجيل الدخول لاستخدام المساعد الذكي.');
  }
  const idToken = await user.getIdToken(false);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(resolveApiUrl(path), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        ...body,
        tokenProjectId: activeFirebaseConfig.projectId,
        tokenApiKey: activeFirebaseConfig.apiKey,
        tokenFirestoreDatabaseId: activeFirebaseConfig.firestoreDatabaseId || '',
      }),
    });
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error('BACKEND_UNAVAILABLE');
    }
    const data = (await resp.json()) as T & { error?: string };
    if (!resp.ok) {
      throw new Error(data?.error || `تعذر الاتصال بالمساعد الذكي (${resp.status})`);
    }
    return data;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function checkAiServerStatus(): Promise<{ reachable: boolean; aiConfigured: boolean }> {
  if (!isBackendServerDetected()) {
    return { reachable: false, aiConfigured: false };
  }
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 3500);
    const resp = await fetch(resolveApiUrl(`/api/ai/status?t=${Date.now()}`), {
      cache: 'no-store',
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    const ct = resp.headers.get('content-type') || '';
    if (!resp.ok || !ct.includes('application/json')) {
      return { reachable: false, aiConfigured: false };
    }
    const json = (await resp.json()) as { ok?: boolean; aiConfigured?: boolean };
    return { reachable: Boolean(json.ok), aiConfigured: Boolean(json.aiConfigured) };
  } catch {
    return { reachable: false, aiConfigured: false };
  }
}

export async function requestAiDiagnosis(params: {
  studentName: string;
  analytics: LocalAnalyticsSummary;
  memory: CoachMemory;
}): Promise<CoachDiagnosisResult> {
  const { analytics, studentName, memory } = params;
  const res = await callAiEndpoint<{ ok: boolean; diagnosis: CoachDiagnosisResult }>(
    '/api/ai/analyze',
    {
      studentName,
      statsSummary: {
        totalAttempts: analytics.totalAttempts,
        totalQuestions: analytics.totalQuestions,
        correctCount: analytics.correctCount,
        wrongCount: analytics.wrongCount,
        accuracyPct: analytics.accuracyPct,
        avgSecPerQ: analytics.avgSecPerQ,
      },
      topicStats: analytics.sectionStats.slice(0, 12),
      recentMistakes: analytics.recentMistakes.slice(0, 10),
      memory,
      needsFoundationalPlanForSection: analytics.sectionNeedsFoundationalPlan
        ? {
            sectionKey: analytics.sectionNeedsFoundationalPlan.sectionKey,
            sectionTitle: analytics.sectionNeedsFoundationalPlan.sectionTitle,
            reason: `نسبة الإتقان الحالية ${analytics.sectionNeedsFoundationalPlan.accuracyPct}% مع تكرار الأخطاء في تدريبات القسم.`,
          }
        : null,
    }
  );
  return res.diagnosis;
}

export function normalizeGeneratedQuestions(rawQuestions: unknown[], fallbackTitle: string): QuizQuestion[] {
  const bundle = parseQuizBundleJson(
    JSON.stringify({
      title: fallbackTitle,
      questions: rawQuestions,
    })
  );
  return bundle.questions;
}

export async function generateAndSaveSectionQuiz(params: {
  uid: string;
  studentName: string;
  sectionKey: string;
  sectionTitle: string;
  focusTopic: string;
  questionCount?: number;
  mode?: 'remedial' | 'foundational_stage' | 'level_up';
  stageInfo?: {
    order: number;
    title: string;
    objective: string;
    coreConcept: string;
    sampleRule: string;
  } | null;
  analytics: LocalAnalyticsSummary;
  memory: CoachMemory;
  quizzes: MyQuiz[];
}): Promise<MyQuiz> {
  const count = Math.max(3, Math.min(10, Math.round(params.questionCount ?? 5)));
  const res = await callAiEndpoint<{
    ok: boolean;
    title: string;
    ruleTitle: string;
    questions: unknown[];
  }>('/api/ai/generate-quiz', {
    studentName: params.studentName,
    sectionKey: params.sectionKey,
    sectionTitle: params.sectionTitle,
    focusTopic: params.focusTopic,
    questionCount: count,
    mode: params.mode || 'remedial',
    stageInfo: params.stageInfo || null,
    recentMistakes: params.analytics.recentMistakes
      .filter((m) => m.sectionKey === params.sectionKey)
      .slice(0, 6),
    memory: params.memory,
  });

  const cleanQuestions = normalizeGeneratedQuestions(res.questions, res.title);
  if (cleanQuestions.length === 0) {
    throw new Error('لم تحتوي الأسئلة المولّدة على صيغة قابلة للاختبار.');
  }

  // إيجاد القسم الأصلي إن كان موجوداً كـ MyQuiz لربط اختبار التقوية تحته مباشرة
  const matchedParent = params.quizzes.find(
    (q) => q.id === params.sectionKey && !q.parentQuizId && q.quizKind !== 'drill'
  );

  const chunks = await createMyQuizzesAutoSplit(params.uid, res.title, cleanQuestions, {
    ...(matchedParent ? { parentQuizId: matchedParent.id } : {}),
    quizKind: 'drill',
    drillStyle: 'mixed',
    ruleTitle: res.ruleTitle || params.focusTopic,
  });

  const first = chunks[0];
  return {
    id: first.id,
    ownerId: params.uid,
    title: first.title,
    questions: first.questions,
    questionCount: first.questions.length,
    ...(matchedParent ? { parentQuizId: matchedParent.id } : {}),
    quizKind: 'drill',
    drillStyle: 'mixed',
    ruleTitle: res.ruleTitle || params.focusTopic,
    updatedAt: Date.now(),
  };
}

export async function sendAiCoachChatMessage(params: {
  studentName: string;
  message: string;
  requestQuickQuiz?: boolean;
  quickQuizTopic?: string;
  memory: CoachMemory;
  analytics: LocalAnalyticsSummary;
  history: CoachChatMessage[];
}): Promise<{
  reply: string;
  memory: CoachMemory;
  quickQuiz: CoachQuickQuiz | null;
}> {
  const res = await callAiEndpoint<{
    ok: boolean;
    reply: string;
    memoryUpdates: {
      studentPreferredName?: string;
      addPersonalityNotes?: string[];
      addLearningGoals?: string[];
      addCustomFacts?: string[];
    };
    quickQuiz?: {
      title: string;
      topic: string;
      questions: unknown[];
    } | null;
  }>('/api/ai/chat', {
    studentName: params.studentName,
    message: params.message,
    requestQuickQuiz: Boolean(params.requestQuickQuiz),
    quickQuizTopic: params.quickQuizTopic || '',
    memory: params.memory,
    statsSummary: {
      totalAttempts: params.analytics.totalAttempts,
      totalQuestions: params.analytics.totalQuestions,
      correctCount: params.analytics.correctCount,
      accuracyPct: params.analytics.accuracyPct,
      avgSecPerQ: params.analytics.avgSecPerQ,
      topStrengths: params.analytics.strongSections.slice(0, 3).map((s) => `${s.sectionTitle} (${s.accuracyPct}%)`),
      topWeaknesses: params.analytics.weakSections.slice(0, 3).map((s) => `${s.sectionTitle} (${s.accuracyPct}%)`),
      slowTopics: params.analytics.slowSections.slice(0, 3).map((s) => `${s.sectionTitle} (${s.avgSecPerQ} ث)`),
    },
    history: params.history.slice(-10).map((m) => ({ role: m.role, text: m.text })),
  });

  const dedupeAdd = (existing: string[], additions?: string[]) => {
    const out = [...existing];
    for (const item of additions || []) {
      const clean = item.trim();
      if (clean && !out.includes(clean)) out.push(clean);
    }
    return out.slice(-15);
  };

  const nextMemory: CoachMemory = {
    studentPreferredName:
      res.memoryUpdates?.studentPreferredName || params.memory.studentPreferredName,
    personalityNotes: dedupeAdd(params.memory.personalityNotes, res.memoryUpdates?.addPersonalityNotes),
    learningGoals: dedupeAdd(params.memory.learningGoals, res.memoryUpdates?.addLearningGoals),
    weakFocusHistory: params.memory.weakFocusHistory,
    customFacts: dedupeAdd(params.memory.customFacts, res.memoryUpdates?.addCustomFacts),
    updatedAt: Date.now(),
  };

  let quickQuiz: CoachQuickQuiz | null = null;
  if (res.quickQuiz?.questions?.length) {
    try {
      const parsedQuestions = normalizeGeneratedQuestions(
        res.quickQuiz.questions,
        res.quickQuiz.title
      ).slice(0, 5);
      if (parsedQuestions.length > 0) {
        quickQuiz = {
          id: `qq_${Date.now().toString(36)}`,
          title: res.quickQuiz.title,
          topic: res.quickQuiz.topic,
          questions: parsedQuestions,
        };
      }
    } catch {
      quickQuiz = null;
    }
  }

  return {
    reply: res.reply,
    memory: nextMemory,
    quickQuiz,
  };
}

export function buildFoundationalPlanFromDiagnosis(
  sectionKey: string,
  sectionTitle: string,
  diagnosis: CoachDiagnosisResult | null
): FoundationalPlan {
  const sug = diagnosis?.suggestedPlan;
  const rawStages =
    sug?.stages && sug.stages.length >= 2
      ? sug.stages
      : [
          {
            title: 'المرحلة 1: تثبيت القاعدة الأساسية من الصفر',
            objective: 'فهم المفهوم الأساسي وتطبيق القانون المباشر في أمثلة واضحة دون تعقيد.',
            coreConcept: `أساسيات ${sectionTitle}`,
            sampleRule: 'ابدأ بتحديد المعطيات والمطلوب وكتابة القانون قبل الحساب.',
          },
          {
            title: 'المرحلة 2: التدريب الموجّه وتجنب الفخاخ الشائعة',
            objective: 'التمييز بين المعطيات المخادعة وحل 5 أسئلة متدرجة بدقة عالية.',
            coreConcept: `معالجة الأخطاء المتكررة في ${sectionTitle}`,
            sampleRule: 'راجع إشارة الناتج ووحدات القياس قبل اعتماد الإجابة.',
          },
          {
            title: 'المرحلة 3: التحدي السريع وتثبيت الإتقان (100%)',
            objective: 'الوصول إلى حل سريع ودقيق تحت الضغط وإثبات الجاهزية للقسم التالي.',
            coreConcept: `إتقان ${sectionTitle} بالسرعة المطلوبة`,
            sampleRule: 'استخدم التبسيط الذهني والاستبعاد الذكي للخيارات.',
          },
        ];

  const now = Date.now();
  return {
    id: `plan_${now.toString(36)}`,
    sectionKey,
    sectionTitle,
    focusTopic: sug?.focusTopic || sectionTitle,
    reason:
      sug?.reason ||
      `تم تفعيل تقويم المهارات البنائية لقسم «${sectionTitle}» لبناء الأساس خطوة بخطوة حتى الإتقان الكامل.`,
    createdAt: now,
    updatedAt: now,
    stages: rawStages.slice(0, 4).map((st, idx) => ({
      id: `stage_${idx + 1}`,
      order: idx + 1,
      title: st.title,
      objective: st.objective,
      coreConcept: st.coreConcept,
      sampleRule: st.sampleRule,
      targetScorePct: idx === rawStages.length - 1 ? 90 : 80,
      status: idx === 0 ? 'active' : 'locked',
      attemptsCount: 0,
    })),
  };
}

export function applySectionAttemptResultToState(params: {
  state: CoachStateDoc;
  sectionKey: string;
  sectionTitle: string;
  score: number;
  total: number;
  durationSec: number;
  quizId?: string;
}): CoachStateDoc {
  const pct = params.total > 0 ? Math.round((params.score / params.total) * 100) : 0;
  const now = Date.now();
  const prevProg: CoachSectionProgress = params.state.sectionProgress[params.sectionKey] || {
    sectionKey: params.sectionKey,
    sectionTitle: params.sectionTitle,
    drillsCompleted: 0,
    mastered: false,
    repeatedLowCount: 0,
    updatedAt: now,
  };

  const goodSpeed = params.total > 0 ? params.durationSec / params.total < 65 : true;
  const isMastered = pct >= 95 && goodSpeed;
  const nextLowCount = pct < 75 ? prevProg.repeatedLowCount + 1 : 0;

  const nextProg: CoachSectionProgress = {
    ...prevProg,
    sectionTitle: params.sectionTitle,
    drillsCompleted: prevProg.drillsCompleted + 1,
    lastScorePct: pct,
    lastDurationSec: params.durationSec,
    mastered: isMastered || (prevProg.mastered && pct >= 85),
    repeatedLowCount: nextLowCount,
    updatedAt: now,
  };

  let nextPlan = params.state.activeFoundationalPlan;
  let completedPlansCount = params.state.completedPlansCount;

  if (nextPlan && nextPlan.sectionKey === params.sectionKey && !nextPlan.completedAt) {
    let unlockedNext = false;
    const updatedStages = nextPlan.stages.map((st) => {
      const matchedStage =
        (params.quizId && st.quizId === params.quizId) ||
        (!st.quizId && st.status === 'active') ||
        st.status === 'active';
      if (matchedStage && st.status === 'active') {
        const best = Math.max(st.bestScorePct || 0, pct);
        const passed = pct >= st.targetScorePct;
        if (passed) unlockedNext = true;
        return {
          ...st,
          attemptsCount: (st.attemptsCount || 0) + 1,
          bestScorePct: best,
          status: passed ? ('completed' as const) : ('active' as const),
        };
      }
      if (unlockedNext && st.status === 'locked') {
        unlockedNext = false;
        return { ...st, status: 'active' as const };
      }
      return st;
    });

    const allDone = updatedStages.every((s) => s.status === 'completed');
    nextPlan = {
      ...nextPlan,
      updatedAt: now,
      ...(allDone ? { completedAt: now } : {}),
      stages: updatedStages,
    };
    if (allDone) {
      completedPlansCount += 1;
    }
  }

  return {
    ...params.state,
    sectionProgress: {
      ...params.state.sectionProgress,
      [params.sectionKey]: nextProg,
    },
    activeFoundationalPlan: nextPlan,
    completedPlansCount,
    updatedAt: now,
  };
}
