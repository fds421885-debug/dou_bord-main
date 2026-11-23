import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const MODEL_NAME = 'gemini-4-hydrogen';

function getApiKey(): string {
  return (process.env.GEMINI_API_KEY || '').trim();
}

export function isAiConfigured(): boolean {
  return getApiKey().length >= 10;
}

function getAiClient(): GoogleGenAI {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function safeParseJson<T = Record<string, unknown>>(raw: string | undefined | null): T {
  const txt = (raw || '').trim();
  if (!txt) {
    throw new Error('استجابة الذكاء الاصطناعي كانت فارغة');
  }
  try {
    return JSON.parse(txt) as T;
  } catch {
    const fenced = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced && fenced[1]) {
      return JSON.parse(fenced[1].trim()) as T;
    }
    const firstBrace = txt.indexOf('{');
    const lastBrace = txt.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(txt.slice(firstBrace, lastBrace + 1)) as T;
    }
    const firstBracket = txt.indexOf('[');
    const lastBracket = txt.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      return JSON.parse(txt.slice(firstBracket, lastBracket + 1)) as T;
    }
    throw new Error('تعذر قراءة صيغة JSON من استجابة الذكاء الاصطناعي');
  }
}

const DUOBOARD_QUESTION_SCHEMA_GUIDE = `
تنسيق السؤال المطلوب لمنصة DuoBoard (JSON):
كل سؤال في المصفوفة "questions" يمكن أن يكون اختيار من متعدد ("mcq") أو جدول تفاعلي ("table"):
1. الحقول الأساسية لكل سؤال:
   - "questionType": "mcq" أو "table" (الافتراضي "mcq")
   - "text": نص السؤال بوضوح وبالعربية (استخدم $...$ للصيغ الرياضية مثل $س + 5 = 12$ أو $\\frac{1}{2}$).
   - "choices": مصفوفة من 4 خيارات نصية واضحة لأسئلة "mcq" (أو [] لأسئلة "table").
   - "correctIndex": رقم من 0 إلى 3 لأسئلة "mcq" (أو -1 لأسئلة "table").
   - "answer": نص الإجابة النهائية.
   - "laws": مصفوفة قوانين/قواعد عامة مساعدة للطالب بدون كشف الجواب النهائي، مثال: ["مساحة المثلث = (القاعدة × الارتفاع) ÷ 2"].
   - "explanation": شرح مفصل ومبسط خطوة بخطوة لماذا هذه الإجابة صحيحة.
2. الإثراء البصري عند الحاجة (أضفه حين يخدم السؤال كالهندسة والبيانات والمقارنة):
   - "figure": رسم هندسي متجهي دقيق { "title": "...", "grid": false, "points": [{"id":"A","x":0,"y":0,"label":"أ","labelPos":"bottom-left","dot":true}], "elements": [{"type":"polygon","points":["A","B","C"],"fill":"blue","fillOpacity":0.14,"stroke":"ink","sideLabels":["6 سم","8 سم",""]}] }.
     العناصر المدعومة في figure.elements: polygon | segment | circle | arc | angle | label. الإحداثيات منطقية ومتناسبة ومغلقة بدقة.
   - "chart": رسم بياني { "type": "bar"|"hbar"|"line"|"pie", "title": "...", "xLabel": "...", "yLabel": "...", "labels": ["..."], "series": [{"name":"...","values":[10,20]}] }.
   - "table": لأسئلة الجدول التفاعلي { "title":"...", "hasHeaderRow":true, "headers":["القيمة","النسبة"], "rows":[[{"value":"50","isBlank":false},{"value":"","isBlank":true,"inputType":"number","cue":"س","expectedAnswer":"25"}]] }.
   - "explanationTable": { "title": "خطوات الحل", "headers": ["الخطوة","النتيجة"], "rows": [["...","..."]] }.
   - "explanationComparison": { "title": "المقارنة", "firstLabel": "القيمة الأولى", "firstValue": "...", "secondLabel": "القيمة الثانية", "secondValue": "...", "verdict": "القيمة الأولى أكبر" }.
   - "explanationChart" أو "explanationFigure": اختياريان للشرح البصري.
   - "sourceMistakeFp": (اختياري) ضع فيه معرف الخطأ "fp" بالضبط إذا كان السؤال مستخرجاً من قائمة أخطاء الطالب السابقة لتصحيحها وحذفها من الأخطاء عند إجابته بشكل صحيح.
3. تأكد 100% من صحة الحسابات الرياضية وتطابق choices[correctIndex] مع الشرح وanswer.
`;

export interface AnalyzeRequestPayload {
  studentName: string;
  statsSummary: {
    totalAttempts: number;
    totalQuestions: number;
    correctCount: number;
    wrongCount: number;
    accuracyPct: number;
    avgSecPerQ: number;
  };
  topicStats: Array<{
    key: string;
    title: string;
    sectionKey: string;
    sectionTitle: string;
    totalQuestions: number;
    correctCount: number;
    wrongCount: number;
    accuracyPct: number;
    avgSecPerQ: number;
    speedStatus: string;
    strengthStatus: string;
    remedialAttempts: number;
    needsFoundationalPlan: boolean;
  }>;
  recentMistakes: Array<{
    sectionTitle: string;
    questionText: string;
    chosenAnswer: string;
    correctAnswer: string;
    laws?: string[];
  }>;
  memory?: {
    studentPreferredName?: string;
    personalityNotes?: string[];
    learningGoals?: string[];
    customFacts?: string[];
  };
  needsFoundationalPlanForSection?: {
    sectionKey: string;
    sectionTitle: string;
    reason: string;
  } | null;
}

export async function runAiCoachAnalyze(payload: AnalyzeRequestPayload): Promise<Record<string, unknown>> {
  const ai = getAiClient();
  const preferredName = payload.memory?.studentPreferredName || payload.studentName || 'بطل';

  const systemInstruction = `أنت «المساعد الذكي» — معلم ومدرب قدرات وتحصيلي ذكي ودقيق جداً يعمل بشخصية «المحفز الداعم» داخل منصة تعليمية عربية.
مهمتك: تحليل سجل اختبارات الطالب بدقة واقعية بناءً على البيانات المزودة فقط، ثم تحديد:
1) نقاط القوة الحقيقية بالأرقام ("قوي في ...").
2) نقاط الأخطاء وأسبابها المتوقعة ("تخطئ في ...").
3) نقاط البطء في الحل وكيف يسرّعها ("تبطئ في ...").
4) القسم الواحد الأكثر أولوية للتقوية الآن (لا نقوي عشوائياً، بل قسم قسم).
5) إذا تكررت أخطاء الطالب في قسم أو طُلب له تقويم مهارات بنائية، اكتب له خطة «تقويم المهارات البنائية» متدرجة من الصفر (3 إلى 4 مراحل واضحة).
استخدم أسلوباً مشجعاً دافئاً وواضحاً ينادي الطالب باسمه المفضل: ${preferredName}.`;

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `حلّل أداء الطالب التالي وأرجع النتيجة بصيغة JSON مطابقة للمخطط:\n${JSON.stringify(payload)}`,
          },
        ],
      },
    ],
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summaryHeadline: { type: Type.STRING },
          encouragementNote: { type: Type.STRING },
          strengths: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                detail: { type: Type.STRING },
                accuracyPct: { type: Type.NUMBER },
              },
              required: ['title', 'detail', 'accuracyPct'],
            },
          },
          weaknesses: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                sectionKey: { type: Type.STRING },
                sectionTitle: { type: Type.STRING },
                detail: { type: Type.STRING },
                accuracyPct: { type: Type.NUMBER },
              },
              required: ['title', 'sectionKey', 'sectionTitle', 'detail', 'accuracyPct'],
            },
          },
          slowAreas: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                avgSecPerQ: { type: Type.NUMBER },
                advice: { type: Type.STRING },
              },
              required: ['title', 'avgSecPerQ', 'advice'],
            },
          },
          recommendedSectionKey: { type: Type.STRING },
          recommendedSectionTitle: { type: Type.STRING },
          recommendedFocusReason: { type: Type.STRING },
          suggestedPlan: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
              focusTopic: { type: Type.STRING },
              reason: { type: Type.STRING },
              stages: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    objective: { type: Type.STRING },
                    coreConcept: { type: Type.STRING },
                    sampleRule: { type: Type.STRING },
                  },
                  required: ['title', 'objective', 'coreConcept', 'sampleRule'],
                },
              },
            },
          },
        },
        required: [
          'summaryHeadline',
          'encouragementNote',
          'strengths',
          'weaknesses',
          'slowAreas',
          'recommendedSectionKey',
          'recommendedSectionTitle',
          'recommendedFocusReason',
        ],
      },
    },
  });

  const parsed = safeParseJson<Record<string, unknown>>(response.text);
  return {
    ...parsed,
    generatedAt: Date.now(),
  };
}

export interface UnresolvedMistakePromptItem {
  fp: string;
  sectionTitle: string;
  questionText: string;
  choices?: string[];
  chosenAnswer: string;
  correctAnswer: string;
  laws?: string[];
}

export interface GenerateQuizRequestPayload {
  studentName: string;
  sectionKey: string;
  sectionTitle: string;
  focusTopic: string;
  questionCount?: number;
  mode?: 'remedial' | 'foundational_stage' | 'level_up' | 'mistakes_review';
  stageInfo?: {
    order: number;
    title: string;
    objective: string;
    coreConcept: string;
    sampleRule: string;
  } | null;
  recentMistakes?: Array<{
    fp?: string;
    questionText: string;
    chosenAnswer: string;
    correctAnswer: string;
    laws?: string[];
  }>;
  unresolvedMistakes?: UnresolvedMistakePromptItem[];
  memory?: {
    studentPreferredName?: string;
    personalityNotes?: string[];
  };
}

export async function runAiCoachGenerateQuiz(
  payload: GenerateQuizRequestPayload
): Promise<{ title: string; ruleTitle: string; questions: unknown[] }> {
  const ai = getAiClient();
  const requestedCount = Math.max(1, Math.min(10, Math.round(Number(payload.questionCount) || 5)));
  const unresolvedList = Array.isArray(payload.unresolvedMistakes)
    ? payload.unresolvedMistakes.slice(0, 10)
    : [];
  const count =
    payload.mode === 'mistakes_review' && unresolvedList.length > 0
      ? Math.min(requestedCount, unresolvedList.length)
      : Math.max(3, requestedCount);
  const preferredName = payload.memory?.studentPreferredName || payload.studentName || 'الطالب';

  const modeNote =
    payload.mode === 'mistakes_review'
      ? `الهدف: مراجعة وتصحيح الأخطاء الفعلية التي وقع فيها الطالب سابقاً!
اختر ${count} أسئلة مباشرة من قائمة "unresolvedMistakes" أدناه، وحافظ على فكرة السؤال وخياراته الصحيحة بدقة مع كتابة شرح واضح وتنبيه لما أخطأ فيه الطالب سابقاً، وضع في كل سؤال الحقل "sourceMistakeFp" مساوياً لقيمة "fp" المطابقة تماماً ليُحذف الخطأ من سجل الطالب ويُحتسب صح عند حله صحيحاً.`
      : payload.mode === 'foundational_stage' && payload.stageInfo
      ? `هذا الاختبار هو المرحلة رقم ${payload.stageInfo.order} من خطة تقويم المهارات البنائية:
عنوان المرحلة: ${payload.stageInfo.title}
الهدف البنائي: ${payload.stageInfo.objective}
المفهوم الأساسي: ${payload.stageInfo.coreConcept}
اجعل الأسئلة متدرجة من الفهم المباشر والأساسيات ثم التطبيق السليم بدون تعقيد مفاجئ.`
      : payload.mode === 'level_up'
      ? 'الهدف: تثبيت الإتقان ورفع سرعة الحل في القسم بأفكار ذكية متدرجة.'
      : 'الهدف: تقوية نقطة الضعف في هذا القسم فقط ومعالجة أسباب الأخطاء السابقة بتنوع ذكي.';

  const prompt = `أنشئ اختباراً تدريبياً متقناً من ${count} أسئلة فقط (لا تزيد ولا تنقص عن ${count}) للطالب "${preferredName}".
القسم المستهدف: ${payload.sectionTitle}
نقطة التركيز: ${payload.focusTopic}
${modeNote}

${
  payload.mode === 'mistakes_review' && unresolvedList.length > 0
    ? `قائمة أخطاء الطالب الفعلية غير المصححة بعد (استخدم "fp" كما هو داخل "sourceMistakeFp"):\n${JSON.stringify(
        unresolvedList
      )}`
    : payload.recentMistakes?.length
    ? `أخطاء الطالب السابقة التي نريد معالجتها:\n${JSON.stringify(payload.recentMistakes.slice(0, 6))}`
    : ''
}

${DUOBOARD_QUESTION_SCHEMA_GUIDE}

أرجع JSON فقط بالبنية:
{
  "title": "عنوان جذاب مختصر للاختبار",
  "ruleTitle": "القاعدة أو المهارة الأساسية",
  "questions": [ ... ${count} أسئلة كاملة ومشروحة بالتفصيل الممل ومعها laws ورسوم figure/chart أو جدول تفاعلي عند مناسبتها ... ]
}`;

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction:
        'أنت خبير بناء اختبارات قدرات ورياضيات عربية لمنصة DuoBoard. تكتب أسئلة خالية من الأخطاء الحسابية، مع شروحات وافية وجداول/أشكال متجهية دقيقة عند ملاءمتها لموضوع السؤال.',
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
    },
  });

  const parsed = safeParseJson<{ title?: string; ruleTitle?: string; questions?: unknown[] }>(
    response.text
  );
  const questions = Array.isArray(parsed.questions) ? parsed.questions.slice(0, count) : [];
  if (questions.length === 0) {
    throw new Error('لم يولّد المساعد الذكي أي أسئلة صالحة، أعد المحاولة.');
  }

  return {
    title:
      typeof parsed.title === 'string' && parsed.title.trim()
        ? parsed.title.trim()
        : payload.mode === 'mistakes_review'
        ? 'اختبار تصحيح أخطائك السابقة'
        : `تقوية: ${payload.focusTopic || payload.sectionTitle}`,
    ruleTitle:
      typeof parsed.ruleTitle === 'string' && parsed.ruleTitle.trim()
        ? parsed.ruleTitle.trim()
        : payload.focusTopic || payload.sectionTitle,
    questions,
  };
}

export interface ChatRequestPayload {
  studentName: string;
  message: string;
  requestQuickQuiz?: boolean;
  quickQuizTopic?: string;
  memory: {
    studentPreferredName?: string;
    personalityNotes: string[];
    learningGoals: string[];
    weakFocusHistory: string[];
    customFacts: string[];
  };
  statsSummary: {
    totalAttempts: number;
    totalQuestions: number;
    correctCount: number;
    wrongCount?: number;
    correctedMistakesCount?: number;
    accuracyPct: number;
    avgSecPerQ: number;
    topStrengths: string[];
    topWeaknesses: string[];
    slowTopics: string[];
  };
  unresolvedMistakes?: UnresolvedMistakePromptItem[];
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export async function runAiCoachChat(payload: ChatRequestPayload): Promise<{
  reply: string;
  memoryUpdates: {
    studentPreferredName?: string;
    addPersonalityNotes: string[];
    addLearningGoals: string[];
    addCustomFacts: string[];
  };
  quickQuiz?: {
    title: string;
    topic: string;
    questions: unknown[];
  } | null;
}> {
  const ai = getAiClient();
  const preferredName = payload.memory.studentPreferredName || payload.studentName || 'بطل';
  const unresolvedList = Array.isArray(payload.unresolvedMistakes)
    ? payload.unresolvedMistakes.slice(0, 8)
    : [];

  const systemInstruction = `أنت «المساعد الذكي» داخل منصة DuoBoard.
شخصيتك: «المحفز الداعم» — صديق ومعلم ذكي، دافئ، مشجع بلا تصنع، سريع البديهة، يتذكر الطالب وأسلوبه.
الذاكرة الحالية عن الطالب:
- الاسم المفضل: ${preferredName}
- ملاحظات الشخصية: ${payload.memory.personalityNotes.join(' | ') || 'لا توجد بعد'}
- الأهداف: ${payload.memory.learningGoals.join(' | ') || 'رفع الدرجة والإتقان'}
- حقائق محفوظة: ${payload.memory.customFacts.join(' | ') || 'لا توجد بعد'}

ملخص أداء الطالب الفعلي:
- إجمالي الأسئلة المحلولة: ${payload.statsSummary.totalQuestions} (${payload.statsSummary.accuracyPct}% دقة، ${payload.statsSummary.avgSecPerQ} ث/سؤال)
- الأخطاء المتبقية حالياً: ${payload.statsSummary.wrongCount ?? 0} | الأخطاء التي صححها الطالب سابقاً: ${payload.statsSummary.correctedMistakesCount ?? 0}
- نقاط القوة: ${payload.statsSummary.topStrengths.join('، ') || 'قيد التقييم'}
- نقاط تحتاج تقوية: ${payload.statsSummary.topWeaknesses.join('، ') || 'لا توجد أخطاء مسجلة بعد'}
- مواضع البطء: ${payload.statsSummary.slowTopics.join('، ') || 'لا يوجد بطء ملحوظ'}

${
  unresolvedList.length > 0
    ? `أسئلة أخطأ فيها الطالب في اختبارات سابقة ولم يصححها بعد:\n${JSON.stringify(unresolvedList)}`
    : 'لا توجد أخطاء معلقة غير مصححة حالياً.'
}

قواعد مهمة:
1) إذا أخبرك الطالب باسمه أو لقبه المفضل أو معلومة شخصية/دراسية أو هدف أو تفضيل، احفظها في "memoryUpdates" فوراً.
2) إذا طلب الطالب اختباراً من أخطائه السابقة، أو اختباراً سريعاً لقياس مستواه وتوجد أخطاء معلقة، اجعل أسئلة "quickQuiz" (من 1 إلى 5 أسئلة، وحتى 5 كحد أقصى) مأخوذة مباشرة من قائمة الأخطاء المعلقة أعلاه مع وضع "sourceMistakeFp": "<fp>" في كل سؤال مطابق؛ لأن النظام عند حله صحيحاً سيزيله من الأخطاء ويحتسبه صح فوراً! وفي الحوار العادي اجعل "quickQuiz" يساوي null.
3) لا تفجع الطالب بأسئلة كثيرة؛ دائماً اختبار سريع خفيف وذكي (حتى 5 أسئلة).
${DUOBOARD_QUESTION_SCHEMA_GUIDE}`;

  const historyParts = payload.history.slice(-10).map((m) => ({
    role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
    parts: [{ text: m.text }],
  }));

  const userPrompt = payload.requestQuickQuiz
    ? `${payload.message}\n(ملاحظة النظام: الطالب يطلب الآن اختباراً سريعاً مدمجاً داخل المحادثة من حتى 5 أسئلة لقياس مستواه وتصحيح أخطائه في: ${payload.quickQuizTopic || 'الأخطاء السابقة'}).`
    : payload.message;

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: [...historyParts, { role: 'user', parts: [{ text: userPrompt }] }],
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: payload.requestQuickQuiz ? ThinkingLevel.MEDIUM : ThinkingLevel.LOW },
    },
  });

  const parsed = safeParseJson<{
    reply?: string;
    memoryUpdates?: {
      studentPreferredName?: string;
      addPersonalityNotes?: string[];
      addLearningGoals?: string[];
      addCustomFacts?: string[];
    };
    quickQuiz?: {
      title?: string;
      topic?: string;
      questions?: unknown[];
    } | null;
  }>(response.text);

  const mem = parsed.memoryUpdates || {};
  const qq =
    parsed.quickQuiz && Array.isArray(parsed.quickQuiz.questions) && parsed.quickQuiz.questions.length > 0
      ? {
          title:
            typeof parsed.quickQuiz.title === 'string' && parsed.quickQuiz.title.trim()
              ? parsed.quickQuiz.title.trim()
              : 'اختبار سريع لقياس المستوى',
          topic:
            typeof parsed.quickQuiz.topic === 'string' && parsed.quickQuiz.topic.trim()
              ? parsed.quickQuiz.topic.trim()
              : payload.quickQuizTopic || 'تقييم سريع',
          questions: parsed.quickQuiz.questions.slice(0, 5),
        }
      : null;

  return {
    reply:
      typeof parsed.reply === 'string' && parsed.reply.trim()
        ? parsed.reply.trim()
        : `أهلاً بك يا ${preferredName}! أنا معك خطوة بخطوة، كيف تحب نبدأ تقوية مهارتك الآن؟`,
    memoryUpdates: {
      ...(typeof mem.studentPreferredName === 'string' && mem.studentPreferredName.trim()
        ? { studentPreferredName: mem.studentPreferredName.trim().slice(0, 60) }
        : {}),
      addPersonalityNotes: Array.isArray(mem.addPersonalityNotes)
        ? mem.addPersonalityNotes.filter((x): x is string => typeof x === 'string' && Boolean(x.trim())).slice(0, 4)
        : [],
      addLearningGoals: Array.isArray(mem.addLearningGoals)
        ? mem.addLearningGoals.filter((x): x is string => typeof x === 'string' && Boolean(x.trim())).slice(0, 4)
        : [],
      addCustomFacts: Array.isArray(mem.addCustomFacts)
        ? mem.addCustomFacts.filter((x): x is string => typeof x === 'string' && Boolean(x.trim())).slice(0, 4)
        : [],
    },
    quickQuiz: qq,
  };
}
