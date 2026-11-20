import { deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from './firestoreTracked';
import { db, handleFirestoreError, OperationType } from './firebase';
import type { DrillStyle, MyQuiz, QuestionKind, QuizQuestion } from './types';
import { chartProblem, parseChart, sanitizeChart } from './quizChart';
import { figureProblem, parseFigure, sanitizeFigure } from './quizFigure';
import { saveMyQuizMetaOverride } from './localDraftStore';
import { notifyRulesUpdateNeeded } from './starredQuestions';
import {
  parseTableQuestion,
  sanitizeExplanationComparison,
  sanitizeExplanationTable,
  sanitizeTableQuestion,
  tableQuestionProblem,
} from './quizTable';

export const LIMITS = {
  maxQuestions: 100,
  title: 120,
  text: 2000,
  choice: 500,
  maxChoices: 8,
  answer: 1000,
  explanation: 4000,
  maxBytes: 900_000, // حد المستند في Firestore ≈ 1MB
} as const;

function rand(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function newQuestionId(): string {
  return `q_${Date.now().toString(36)}${rand()}`;
}

export function newQuizId(): string {
  return `quiz_${Date.now().toString(36)}${rand()}`;
}

export function emptyQuestion(questionType: QuestionKind = 'mcq'): QuizQuestion {
  return {
    id: newQuestionId(),
    questionType,
    text: '',
    choices: questionType === 'table' ? [] : ['', '', '', ''],
    correctIndex: -1,
    answer: '',
    explanation: '',
  };
}

/* ------------------------------------------------------------------ */
/*  سكريبت الذكاء الاصطناعي الذي ينسخه المستخدم قبل الاستيراد         */
/* ------------------------------------------------------------------ */

export const DRILL_STYLE_LABELS: Record<DrillStyle, string> = {
  same_values: 'نفس المسألة بتغيير القيم والأرقام فقط',
  same_law_ideas: 'نفس القانون بأفكار وزوايا مختلفة',
  mixed: 'متنوع وشامل (تغيير قيم + أفكار مختلفة + قدرات متدرجة)',
};

export interface MainImportPromptOptions {
  includeRuleDrills?: boolean;
  drillQuestionsPerRule?: number;
  drillStyle?: DrillStyle;
}

export function buildMainImportPrompt(options: MainImportPromptOptions = {}): string {
  const {
    includeRuleDrills = false,
    drillQuestionsPerRule = 5,
    drillStyle = 'mixed',
  } = options;
  const clampedPerRule = Math.max(2, Math.min(30, Math.round(drillQuestionsPerRule || 5)));

  const bundleBlock = includeRuleDrills
    ? `
================================================================
وضع الحزمة المتكاملة المطلوب الآن: الاختبار الأساسي + اختبارات تقوية منفصلة لكل قاعدة!
================================================================
المطلوب في ملف JSON الناتج أن يحتوي على:
1) "title" و "questions": الاختبار الأساسي الشامل للمادة كاملة.
2) "subQuizzes": مصفوفة إلزامية تحتوي على **اختبار تدريب وتقوية منفصل لكل قاعدة أو قانون أو مهارة رئيسية** وردت في المادة، بحيث يظهر كل تدريب تحت الاختبار الأساسي للطالب:
   "subQuizzes": [
     {
       "title": "تدريب قاعدة: اسم القاعدة أو المهارة بوضوح",
       "ruleTitle": "الاسم المختصر للقاعدة (مثلاً: التدرج المنتظم / الزوايا المتقابلة)",
       "drillStyle": "${drillStyle}",
       "questions": [
         /* أنشئ هنا ${clampedPerRule} أسئلة تدريبية مركزة على هذه القاعدة وحدها، مع شرح مفصل وطرق القدرات */
       ]
     }
   ]
- عدد الأسئلة داخل كل عنصر في "subQuizzes": نحو ${clampedPerRule} أسئلة متدرجة بأسلوب (${DRILL_STYLE_LABELS[drillStyle]}).
- تأكد أن كل سؤال داخل "subQuizzes" يلتزم بنفس قواعد الـ JSON والـ LaTeX والجداول التفاعلية والأشكال والرسوم والشرح المفصل المذكورة أدناه، وأن يكون مختلفاً وجديداً للتدريب الفعلي وليس مجرد تكرار حرفي لنفس أرقام الاختبار الأساسي.
`
    : '';

  return `${PROMPT_HEAD}${bundleBlock}\n${PROMPT_TAIL}`;
}

const PROMPT_HEAD = String.raw`أنت معلم خبير ومؤلف اختبارات محترف في المناهج الدراسية واختبارات «القدرات العامة» (الكمي واللفظي) والرياضيات والهندسة والعلوم.
مهمتك: تحويل المادة أو الأسئلة أو الملف المرفق أدناه إلى اختبار تفاعلي متكامل وإخراج الناتج على شكل **ملف JSON واحد فقط** داخل كتلة كود واحدة (\`\`\`json ... \`\`\`) دون أي كلام أو شرح أو مقدمات قبلها أو بعدها.

================================================================
أولاً: الهيكل العام للملف (يدعم صيغتين للأسئلة: اختيار من متعدد + جداول تفاعلية)
================================================================
{
  "title": "عنوان مناسب ومختصر للاختبار (حتى 120 حرفاً)",
  "questions": [
    {
      "questionType": "mcq",
      "text": "نص السؤال (يدعم LaTeX بين $...$ مثل $\\frac{3}{4}$ و $\\sqrt{16}$)",
      "figure": { ... },
      "chart": { ... },
      "choices": ["الخيار 1", "الخيار 2", "الخيار 3", "الخيار 4"],
      "correctIndex": 1,
      "explanation": "شرح مفصل جداً خطوة بخطوة + طرق القدرات السريعة + مثال توضيحي عند الحاجة...",
      "explanationComparison": { ... },
      "explanationTable": { ... },
      "explanationChart": { ... },
      "explanationFigure": { ... }
    },
    {
      "questionType": "table",
      "text": "أكمل الجدول التالي بإيجاد القيم المفقودة (س، ص، التصنيف):",
      "table": {
        "title": "العلاقة بين عدد الساعات والمسافة",
        "caption": "لاحظ أن السرعة ثابتة في كل الحالات",
        "hasHeaderRow": true,
        "headers": ["الزمن (ساعات)", "المسافة (كم)", "الحالة"],
        "rows": [
          [
            { "value": "$2$", "isBlank": false },
            { "value": "$120$", "isBlank": false },
            { "value": "سريع", "isBlank": false }
          ],
          [
            { "value": "$5$", "isBlank": false },
            { "value": "", "isBlank": true, "inputType": "number", "cue": "س", "expectedAnswer": "300" },
            { "value": "", "isBlank": true, "inputType": "text", "cue": "ص", "expectedAnswer": "سريع|ثابت" }
          ]
        ]
      },
      "explanation": "الطريقة الأسرع بالقدرات (التدرج المنتظم):\nكل ساعة يقطع $\\frac{120}{2} = 60$ كم.\nإذن في $5$ ساعات: $س = 5 \\times 60 = 300$ كم.",
      "explanationTable": {
        "title": "خطوات التدرج المنتظم",
        "headers": ["الخطوة", "الزمن", "المسافة"],
        "rows": [
          ["المعطى", "$2$ ساعة", "$120$ كم"],
          ["القسمة على 2", "$1$ ساعة", "$60$ كم"],
          ["الضرب في 5", "$5$ ساعات", "$300$ كم"]
        ]
      }
    }
  ]
}`;

const PROMPT_TAIL = String.raw`================================================================
ثانياً: قواعد صارمة للصياغة والدقة الحسابية
================================================================
1) JSON صالح 100%: علامات اقتباس مزدوجة (") فقط، بدون تعليقات (//)، بدون فواصل زائدة، بدون أي نص خارج كتلة الكود.
2) العدد الأقصى 100 سؤال في الملف. تحقق حسابياً بنفسك من كل مسألة قبل كتابتها ولا تفترض الإجابة أبداً.
3) في أسئلة الاختيار من متعدد ("questionType": "mcq" أو بدون تحديد questionType):
   - "choices": مصفوفة من 2 إلى 8 خيارات (يفضّل 4 خيارات متزنة وواقعية).
   - "correctIndex": رقم الخيار الصحيح يبدأ من 0 (0، 1، 2، 3...). نوّع موضع الإجابة الصحيحة في كل سؤال ولا تكرر نفس الرقم.
   - تأكد 100% أن choices[correctIndex] يطابق ناتج الحساب الصحيح.

================================================================
ثالثاً: مواصفات أسئلة الجداول التفاعلية ("questionType": "table")
================================================================
استخدم هذه الصيغة متى احتاج السؤال أن يملأ الطالب خانات ناقصة داخل جدول (أرقام أو كلمات/رموز أو متغيرات مثل س، ص، أ، ب):
- ضع "questionType": "table" ولا حاجة لمصفوفة choices (تُترك [] أو تُحذف).
- داخل "table":
  • "title" (اختياري): عنوان الجدول.
  • "caption" (اختياري): ملحوظة توضيحية أسفل الجدول.
  • "hasHeaderRow": true/false (اجعلها true عندما يحتوي "headers" عناوين الأعمدة).
  • "headers": مصفوفة نصوص بعناوين الأعمدة (بنفس عدد الأعمدة في كل صف).
  • "rows": مصفوفة من الصفوف، كل صف مصفوفة خلايا بنفس الطول:
    - للخلية الثابتة المعروضة للطالب:
      { "value": "النص أو الرقم أو معادلة LaTeX مثل $12$", "isBlank": false }
    - للخلية الفارغة التي يكتب الطالب إجابتها:
      {
        "value": "",
        "isBlank": true,
        "inputType": "number" أو "text",
        "cue": "رمز أو حرف يظهر للطالب داخل الفراغ مثل: س أو ص أو أ (اختياري، اتركه \"\" إذا لم يكن هناك حرف)",
        "expectedAnswer": "الإجابة الصحيحة (مثال للرقم: \"25\"، وللنص عدة صيغ محتملة مفصولة بـ | مثل \"متطابقان|متساويان\")"
      }
  • انتبه:
    - استخدم "inputType": "number" عندما يكون المطلوب عدداً (المصحح التلقائي في البرنامج يحوّل الأرقام العربية ١٢٣ إلى 123 ويقارن القيمة العددية تلقائياً). ضع في expectedAnswer الرقم الصافي مثل "300" أو "12.5" دون رموز $.
    - استخدم "inputType": "text" عندما يكون المطلوب كلمة أو عبارة أو وصفاً (مثل: "موجب"، "أكبر"، "مثلث قائم"). يمكنك كتابة عدة إجابات مقبولة مفصولة بعلامة | مثل "مربع|المربع".
    - إذا كان مكتوباً في المادة رمز مكان الإجابة (مثل: س، ص، ؟، أ)، ضعه في حقل "cue" ليظهر للطالب فوق خانة الكتابة!

================================================================
رابعاً: منهجية الشرح الاحترافي التفصيلي (مهم جداً — التزم بها في "explanation" وما يتبعها!)
================================================================
اجعل الشرح غنياً جداً وواضحاً وكأنه درس خصوصي ممتاز يُغني الطالب عن سؤال المعلم، خاصةً في **القدرات الكمي واللفظي والرياضيات**:
1) **التدرج الواضح خطوة بخطوة**:
   - اذكر الفكرة أو القانون المستعمل أولاً (مثال: «قانون مساحة المثلث»، «علاقة التناسب العكسي»، «التناظر اللفظي: علاقة جزء من كل»).
   - اكتب كل خطوة حسابية في سطر مستقل (\n) مع تفسير سببها باختصار واضح دون قفز بين الخطوات.
2) **استراتيجيات وطرق القدرات السريعة (أضفها للمسائل الكمية كلما ناسبت)**:
   - بيّن «الطريقة التقليدية بالمعادلات» ثم أضف تحتها «طريقة القدرات السريعة» مثل:
     * **التدرج المنتظم** (للنسب والتناسب والسرعة والزمن).
     * **التجريب في الخيارات** (واذكر كيف نبدأ غالباً بالخيار الأوسط أو الرقم الأسهل).
     * **استبعاد الخيارات المستحيلة** (بالمنطق أو إشارة الناتج أو خانة الآحاد).
     * **افتراض قيم سهلة** (مثل فرض $س = 100$ للنسب المئوية أو فرض قيم بسيطة مثل $1$ أو $2$).
     * **الرسم والتبسيط الهندسي**.
3) **إدراج أمثلة توضيحية ومقارنات وجداول ورسوم داخل الشرح نفسه** (يُعرض كلها للطالب بشكل بصري أنيق في صفحة المراجعة!):
   - أ) **فقرة مثال مبسّط داخل "explanation"**: إذا كانت القاعدة مجرّدة أو تحتاج تثبيتاً، أضف مثالاً مصغراً داخل explanation مثل: «مثال مشابه للتوضيح: لو كان العدد 20 فإن 10% منه = 2».
   - ب) **مربعات المقارنة ("explanationComparison") — ممتازة لأسئلة المقارنة في القدرات (القيمة الأولى vs القيمة الثانية) أو للمقارنة بين طريقتين أو حالتين**:
     "explanationComparison": {
       "title": "مقارنة القيمتين",
       "firstLabel": "القيمة الأولى",
       "firstValue": "$3^{4} = 81$",
       "secondLabel": "القيمة الثانية",
       "secondValue": "$4^{3} = 64$",
       "verdict": "القيمة الأولى ($81$) أكبر من القيمة الثانية ($64$)"
     }
   - ج) **جداول الشرح التوضيحية ("explanationTable") — لتنظيم المعطيات، المقارنات، التدرج المنتظم، حالات س/ص، أو القوانين**:
     "explanationTable": {
       "title": "تنظيم المعطيات والحل بالتدرج",
       "headers": ["الكمية", "النسبة", "القيمة"],
       "rows": [
         ["الأصل", "$100\\%$", "$400$"],
         ["الخصم ($15\\%$)", "$15\\%$", "$60$"],
         ["بعد الخصم", "$85\\%$", "$340$"]
       ]
     }
     (كما يمكنك أيضاً وضع جدول Markdown بسيط داخل "explanation" بصيغة | العمود 1 | العمود 2 | وسيحوّله البرنامج إلى جدول منسق تلقائياً، لكن الأفضل استخدام الحقل المنظم "explanationTable").
   - د) **رسم بياني داخل الشرح ("explanationChart")** وشكل هندسي داخل الشرح ("explanationFigure")**: إذا كان وضع رسم مبسّط أو رسم خط إضافي أو تقسيم شكل يوضّح الحل أكثر، أضفه بنفس بنية chart أو figure!

================================================================
خامساً: الأشكال الهندسية المتجهية الدقيقة ("figure" و "explanationFigure")
================================================================
متى تستخدمها؟ كلما تضمن السؤال أو الشرح: مثلثاً، مربعاً، مستطيلاً، دائرة، قطاعاً، مضلعاً، زوايا متقابلة بالرأس، مستقيمات متوازية وقاطعاً، زاوية خارجية، دائرة داخل مربع (مناطق مظللة)، أو مجاهيل مثل س / ص / 2س + 10°.
نظام الإحداثيات: ديكارتي قياسي (Y للأعلى، X لليمين، الزاوية 0° لليمين و90° للأعلى).
البنية الدقيقة:
{
  "title": "عنوان الشكل (اختياري)",
  "caption": "ملحوظة أسفل الشكل (اختياري)",
  "grid": false,
  "points": [
    { "id": "A", "x": 0, "y": 4, "label": "أ", "labelPos": "top", "dot": true }
  ],
  "elements": [ ... ]
}
- ألوان fill / stroke / color المسموحة فقط: "ink" | "blue" | "green" | "gold" | "purple" | "red" | "gray" | "white" | "none" (لـ fill فقط).
- عناصر elements الستة بدقة:
  1) "polygon": { "type": "polygon", "points": ["A","B","C"], "fill": "blue", "fillOpacity": 0.16, "stroke": "ink", "dashed": false, "sideLabels": ["3 سم","4 سم","س"], "ticks": [1,1,0] }
  2) "segment": { "type": "segment", "from": "A", "to": "B", "extendFrom": true, "extendTo": true, "stroke": "ink", "dashed": false, "label": "5 سم", "ticks": 1, "parallel": 1 }
  3) "circle": { "type": "circle", "center": "O", "r": 3, "fill": "none", "fillOpacity": 0.2, "stroke": "ink", "showCenter": true, "radiusAngleDeg": 0, "radiusLabel": "نق = 5", "diameterAngleDeg": 90, "diameterLabel": "ق = 10" }
  4) "arc": { "type": "arc", "center": "O", "r": 4, "startDeg": 0, "endDeg": 60, "sector": true, "fill": "gold", "fillOpacity": 0.45, "stroke": "gold", "label": "طول القوس" }
  5) "angle": { "type": "angle", "a": "B", "vertex": "A", "b": "C", "label": "س°", "right": false, "arcs": 1, "reflex": false, "color": "red", "r": 1.2 }
     (للزاوية القائمة ضع "right": true).
  6) "label": { "type": "label", "x": 3, "y": 5.5, "text": "الجزء المظلل", "color": "blue" }
- للمناطق المظللة (مثل دائرة داخل مربع): ارسم المضلع الخارجي أولاً بـ fill:"blue", fillOpacity:0.35 ثم ارسم الدائرة/المضلع الداخلي بعده بـ fill:"white", fillOpacity:1!
- للأشكال المعقدة (متوازيان وقاطع / زوايا متقابلة): حافظ بدقة رياضية على تساوي الميل Δy/Δx لجميع النقاط الواقعة على نفس المستقيم.

================================================================
سادساً: الرسوم البيانية ("chart" و "explanationChart")
================================================================
"chart": {
  "type": "bar" | "hbar" | "line" | "pie",
  "title": "عنوان الرسم",
  "xLabel": "المحور الأفقي",
  "yLabel": "المحور الرأسي",
  "labels": ["أ", "ب", "ج"],
  "series": [ { "name": "السلسلة", "values": [10, 25, 18] } ]
}
(تأكد أن طول values يساوي طول labels وأن القيم أرقام صافية).

================================================================
سابعاً: تنسيق الرياضيات والرموز (LaTeX) داخل النصوص
================================================================
- ضع التعبيرات الرياضية بين $...$ مثلاً: $\\frac{3}{4}$ ، $\\sqrt{x}$ ، $\\sqrt[3]{27}$ ، $x^{2}$ ، $90^{\\circ}$
- رموز مفيدة: $\\times$ ، $\\div$ ، $\\pm$ ، $\\leq$ ، $\\geq$ ، $\\neq$ ، $\\approx$ ، $\\pi$ ، $\\theta$ ، $\\alpha$ ، $\\Delta$ ، $\\angle$ ، $\\perp$ ، $\\parallel$ ، $\\Rightarrow$
- قاعدة الشرطات المائلة داخل JSON: اكتب كل شرطة مائلة مرتين "\\" مثل "$\\frac{1}{2}$" و "$\\sqrt{49}$"، وللسطر الجديد اكتب "\n".
- لا تستخدم علامات HTML مثل <br> أو ** حول العناوين.

المادة أو الأسئلة المطلوب تحويلها إلى اختبار الآن:
(الصق هنا المادة أو الأسئلة أو أرفق الملف)`;

export const IMPORT_PROMPT = `${PROMPT_HEAD}\n${PROMPT_TAIL}`;

export interface DrillPromptParams {
  question: QuizQuestion;
  sourceTitle?: string;
  questionCount: number;
  drillStyle: DrillStyle;
  suggestedTitle?: string;
  customNote?: string;
}

export function buildDrillPromptForQuestion(params: DrillPromptParams): string {
  const {
    question,
    sourceTitle,
    questionCount,
    drillStyle,
    suggestedTitle,
    customNote,
  } = params;
  const count = Math.max(1, Math.min(50, Math.round(questionCount || 5)));

  const styleInstructions =
    drillStyle === 'same_values'
      ? `**النمط المطلوب: نفس المسألة وقالب السؤال تماماً مع تغيير الأرقام والقيم فقط**
- حافظ على نفس الصياغة والهيكل والخطوات والقانون حرفياً في كل سؤال جديد.
- غيّر الأرقام أو المعطيات/الجدول/الزوايا والأبعاد فقط في كل سؤال لتدريب الطالب على سرعة الحل وتثبيت الخطوات بدون أخطاء حسابية.
- تأكد من إعادة حساب الإجابة الصحيحة، وتحديث الاختيارات أو خلايا الجدول (expectedAnswer) والشرح والجداول التوضيحية والأشكال الهندسية بالأرقام الجديدة في كل سؤال بدقة 100%.`
      : drillStyle === 'same_law_ideas'
      ? `**النمط المطلوب: نفس القانون أو المهارة الأساسية بأفكار وزوايا صياغة مختلفة**
- استخرج القانون الرئيسي أو المهارة الأساسية من المسألة المرجعية.
- أنشئ ${count} أسئلة تطبيقية تدور جميعها حول نفس القانون، لكن بأفكار ومسائل مختلفة ومتنوعة (مثلاً: عكس المطلوب، معطى غير مباشر، ربط بمجهول س أو ص، سؤال مقارنة بين قيمتين، جدول تفاعلي، مسألة لفظية/هندسية جديدة على نفس المبدأ).
- في شرح كل سؤال اذكر صراحةً كيف استخدمنا نفس القانون، وقارن بين الحل التقليدي وطريقة القدرات السريعة.`
      : `**النمط المطلوب: تدريب شامل ومتنوع متدرج الصعوبة**
- اجمع في الأسئلة الـ ${count} بين ثلاثة مستويات متدرجة على نفس القانون/المهارة:
  1) الثلث الأول: مسائل مباشرة قريبة من المسألة الأصلية مع تغيير الأرقام لتثبيت الثقة.
  2) الثلث الثاني: أفكار متوسطة وعكس المطلوب أو أسئلة جداول تفاعلية ("questionType": "table") عندما يناسب ذلك.
  3) الثلث الثالث: أفكار قدرات متقدمة أو مقارنات ("explanationComparison") وخدع ذكية متكررة في الاختبارات على نفس الفكرة.`;

  const sourcePayload = {
    questionType: question.questionType === 'table' || question.table ? 'table' : 'mcq',
    text: question.text,
    ...(question.table ? { table: question.table } : {}),
    ...(question.choices?.length ? { choices: question.choices, correctIndex: question.correctIndex } : {}),
    ...(question.figure ? { figure: question.figure } : {}),
    ...(question.chart ? { chart: question.chart } : {}),
    ...(question.explanation ? { explanation: question.explanation } : {}),
    ...(question.explanationTable ? { explanationTable: question.explanationTable } : {}),
    ...(question.explanationComparison ? { explanationComparison: question.explanationComparison } : {}),
  };

  const titleHint = (suggestedTitle || `اختبار تقوية: ${question.text.slice(0, 45)}`).slice(0, 120);

  return `أنت معلم خبير ومؤلف تدريبات تقوية مركزة لرفع إتقان الطالب في المناهج واختبارات القدرات (الكمي واللفظي).
المهمة: أنشئ **اختبار تقوية وتدريب مخصص** مكون من **${count} أسئلة جديدة** بناءً على المسألة المرجعية التالية التي أراد الطالب التدرب عليها، وأخرج الناتج على شكل **ملف JSON واحد فقط** داخل كتلة كود واحدة (\`\`\`json ... \`\`\`) دون أي كلام خارج كتلة الكود.

================================================================
المسألة المرجعية المختارة من الطالب${sourceTitle ? ` (من اختبار: ${sourceTitle})` : ''}:
================================================================
${JSON.stringify(sourcePayload, null, 2)}

================================================================
مواصفات اختبار التقوية المطلوب الآن:
================================================================
- عنوان الملف في JSON: ضع "title": "${titleHint}"
- أضف في الجذر: "drillStyle": "${drillStyle}" و "ruleTitle": "اسم القانون أو المهارة المستخلصة من المسألة"
- عدد الأسئلة المطلوب بدقة: ${count} سؤالاً داخل مصفوفة "questions" (تحقق من العدد والحساب في كل سؤال).
${styleInstructions}${
    customNote?.trim()
      ? `\n- ملاحظة إضافية من الطالب: ${customNote.trim()}`
      : ''
  }

================================================================
هيكل ملف JSON والقواعد الكاملة (الجداول التفاعلية + الهندسة + الرسوم + الشرح التفصيلي):
================================================================
${PROMPT_HEAD.slice(PROMPT_HEAD.indexOf('{'))}

${PROMPT_TAIL.slice(0, PROMPT_TAIL.lastIndexOf('المادة أو الأسئلة المطلوب'))}`;
}

/** مثال كامل جاهز للتجربة داخل شاشة الاستيراد (جداول تفاعلية + قدرات + هندسة مركبة + مقارنات + رسوم بيانية + شرح مفصل) */
export const EXAMPLE_JSON = JSON.stringify(
  {
    title: 'نموذج شامل: قدرات وجداول تفاعلية وهندسة ورسوم',
    questions: [
      {
        questionType: 'table',
        text: 'أكمل الجدول التالي الذي يمثل علاقة تناسب طردي بين عدد الكتب والسعر الإجمالي (أوجد قيمتي $س$ و $ص$ ونوع التناسب):',
        table: {
          title: 'سعر الكتب المتماثلة',
          caption: 'اختر نوع كل إجابة بدقة (رقم أو كلمة)',
          hasHeaderRow: true,
          headers: ['عدد الكتب', 'السعر (ريال)', 'ملاحظة'],
          rows: [
            [
              { value: '$3$', isBlank: false },
              { value: '$45$', isBlank: false },
              { value: 'ثابت', isBlank: false },
            ],
            [
              { value: '$7$', isBlank: false },
              { value: '', isBlank: true, inputType: 'number', cue: 'س', expectedAnswer: '105' },
              { value: 'سعر الكتاب الواحد $15$', isBlank: false },
            ],
            [
              { value: '', isBlank: true, inputType: 'number', cue: 'ص', expectedAnswer: '10' },
              { value: '$150$', isBlank: false },
              { value: '', isBlank: true, inputType: 'text', cue: 'نوع التناسب', expectedAnswer: 'طردي|تناسب طردي' },
            ],
          ],
        },
        choices: [],
        correctIndex: -1,
        answer: '',
        explanation:
          'الطريقة التقليدية (حساب قيمة الوحدة):\nسعر الكتاب الواحد $= \\frac{45}{3} = 15$ ريالاً.\n• لإيجاد $س$: $س = 7 \\times 15 = 105$ ريالات.\n• لإيجاد $ص$: $ص = \\frac{150}{15} = 10$ كتب.\n\nطريقة القدرات السريعة (التدرج المنتظم):\nلاحظ أن $150$ تأتي من مضاعفة معطى بسيط ($1$ كتاب $\\leftarrow 15$، نضرب في $10 \\leftarrow 150$).\nونوع التناسب «طردي» لأنه كلما زاد عدد الكتب زاد السعر بنفس النسبة.',
        explanationTable: {
          title: 'جدول الحل السريع بالتدرج المنتظم',
          headers: ['عدد الكتب', 'السعر', 'العملية'],
          rows: [
            ['$3$', '$45$', 'معطى'],
            ['$1$', '$15$', 'قسمة على $3$'],
            ['$7$', '$105$', 'ضرب في $7$ (قيمة س)'],
            ['$10$', '$150$', 'ضرب في $10$ (قيمة ص)'],
          ],
        },
      },
      {
        questionType: 'mcq',
        text: 'قارن بين القيمة الأولى: $3^{44}$ ، والقيمة الثانية: $4^{33}$',
        choices: [
          'القيمة الأولى أكبر',
          'القيمة الثانية أكبر',
          'القيمتان متساويتان',
          'المعطيات غير كافية',
        ],
        correctIndex: 0,
        explanation:
          'في أسئلة مقارنة القوى الكبيرة في القدرات نستخدم استراتيجية «تصغير الأسس» بالقسمة على القاسم المشترك الأكبر للأسّين ($11$):\nالخطوة 1: نقسم الأسس على $11$ فتتحول المقارنة إلى:\nالقيمة الأولى $= 3^{4} = 81$\nالقيمة الثانية $= 4^{3} = 64$\nالخطوة 2: بمقارنة الناتجين نجد أن $81 > 64$، لذا القيمة الأولى أكبر.\n\nمثال مشابه للتوضيح: لمقارنة $2^{30}$ و $3^{20}$ نقسم الأسس على $10$ فتصبح المقارنة بين $2^{3}=8$ و $3^{2}=9$.',
        explanationComparison: {
          title: 'المقارنة بعد تصغير الأسس بالقسمة على 11',
          firstLabel: 'القيمة الأولى',
          firstValue: '$3^{44} \\rightarrow 3^{4} = 81$',
          secondLabel: 'القيمة الثانية',
          secondValue: '$4^{33} \\rightarrow 4^{3} = 64$',
          verdict: 'النتيجة: القيمة الأولى أكبر ($81 > 64$)',
        },
      },
      {
        questionType: 'mcq',
        text: 'في الشكل المقابل، مستقيمان متقاطعان عند النقطة م. ما قيمة $س$؟',
        figure: {
          title: 'زوايا متقابلة بالرأس',
          points: [
            { id: 'M', x: 0, y: 0, label: 'م', dot: true, labelPos: 'bottom' },
            { id: 'A', x: -5, y: -2.2, label: 'أ' },
            { id: 'B', x: 5, y: 2.2, label: 'ب' },
            { id: 'C', x: -3.6, y: 3.4, label: 'ج' },
            { id: 'D', x: 3.6, y: -3.4, label: 'د' },
          ],
          elements: [
            { type: 'segment', from: 'A', to: 'B', extendFrom: true, extendTo: true, stroke: 'ink' },
            { type: 'segment', from: 'C', to: 'D', extendFrom: true, extendTo: true, stroke: 'ink' },
            { type: 'angle', a: 'C', vertex: 'M', b: 'B', label: '115°', color: 'blue', arcs: 1, r: 1.45 },
            { type: 'angle', a: 'A', vertex: 'M', b: 'D', label: '2س + 15°', color: 'red', arcs: 1, r: 1.45 },
          ],
        },
        choices: ['$40$', '$50$', '$57.5$', '$65$'],
        correctIndex: 1,
        explanation:
          'الخطوة 1: الزاويتان متقابلتان بالرأس، إذن قياسهما متساوٍ:\n$2س + 15^{\\circ} = 115^{\\circ}$\nالخطوة 2: نطرح $15^{\\circ}$ من الطرفين:\n$2س = 100^{\\circ} \\Rightarrow س = \\frac{100}{2} = 50$\n\nطريقة القدرات السريعة (التجريب):\nنجرب $س = 50$: $2(50) + 15 = 115^{\\circ}$ ✓ يطابق الزاوية المقابلة مباشرة!',
      },
      {
        questionType: 'mcq',
        text: 'في الشكل المجاور دائرة مرسومة داخل مربع طول ضلعه $10$ سم وتمس أضلاعه الأربعة. ما مساحة المنطقة المظللة؟ (اعتبر $\\pi \\approx 3.14$)',
        figure: {
          title: 'دائرة تمس أضلاع مربع من الداخل',
          caption: 'المنطقة الزرقاء هي المطلوب حساب مساحتها',
          points: [
            { id: 'A', x: 0, y: 6, label: 'أ', labelPos: 'top-left' },
            { id: 'B', x: 6, y: 6, label: 'ب', labelPos: 'top-right' },
            { id: 'C', x: 6, y: 0, label: 'ج', labelPos: 'bottom-right' },
            { id: 'D', x: 0, y: 0, label: 'د', labelPos: 'bottom-left' },
            { id: 'O', x: 3, y: 3, dot: true },
          ],
          elements: [
            {
              type: 'polygon',
              points: ['A', 'B', 'C', 'D'],
              fill: 'blue',
              fillOpacity: 0.35,
              stroke: 'ink',
              sideLabels: ['', '10 سم', '', ''],
            },
            {
              type: 'circle',
              center: 'O',
              r: 3,
              fill: 'white',
              fillOpacity: 1,
              stroke: 'ink',
              showCenter: true,
              radiusAngleDeg: 0,
              radiusLabel: 'نق = 5',
            },
          ],
        },
        choices: ['$21.5\\text{ سم}^{2}$', '$28.5\\text{ سم}^{2}$', '$78.5\\text{ سم}^{2}$', '$100\\text{ سم}^{2}$'],
        correctIndex: 0,
        explanation:
          'قاعدة المنطقة المظللة = مساحة الشكل الخارجي $-$ مساحة الشكل الداخلي غير المظلل.\nمساحة المربع $= 10 \\times 10 = 100\\text{ سم}^{2}$\nطول قطر الدائرة $=$ ضلع المربع $= 10$ سم، إذن نصف القطر $\\text{نق} = 5$ سم.\nمساحة الدائرة $= 3.14 \\times 5^{2} = 3.14 \\times 25 = 78.5\\text{ سم}^{2}$\nالمساحة المظللة $= 100 - 78.5 = 21.5\\text{ سم}^{2}$.',
      },
      {
        questionType: 'mcq',
        text: 'حسب الرسم، ما نسبة من اختار "كرة القدم" إلى المجموع الكلي؟',
        chart: {
          type: 'pie',
          title: 'الرياضة المفضلة',
          xLabel: '',
          yLabel: '',
          labels: ['كرة القدم', 'السباحة', 'الجري'],
          series: [{ name: 'عدد الطلاب', values: [50, 30, 20] }],
        },
        choices: ['$20\\%$', '$30\\%$', '$50\\%$', '$60\\%$'],
        correctIndex: 2,
        explanation: 'المجموع $= 50 + 30 + 20 = 100$ طالب، فتكون نسبة كرة القدم $= \\frac{50}{100} = 50\\%$.',
      },
    ],
  },
  null,
  2
);

/* ------------------------------------------------------------------ */
/*  قراءة ملف JSON بشكل متسامح                                         */
/* ------------------------------------------------------------------ */

const LATEX_AFTER_ESCAPE =
  /^(?:frac|forall|fbox|flat|times|theta|tan|tau|text|textbf|to|therefore|triangle|beta|bar|binom|bigcup|bigcap|big|bullet|boxed|bot|neq|ne|nu|nabla|notin|not|neg|ni|natural|right|rho|rightarrow|underline|upsilon|uparrow|upharpoonleft|rfloor|rceil|rangle|lfloor|lceil|langle|rbrace|lbrace|ldots|cdot|cdots)(?![a-zA-Z])/;

/** يصلح الشرطات المائلة المفردة داخل JSON (مثل \frac و \sqrt) حتى لا تتلف. */
export function sanitizeJsonBackslashes(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) {
      out += '\\\\';
      continue;
    }
    if (next === '\\') {
      out += '\\\\';
      i++;
      continue;
    }
    if (next === '"' || next === '/') {
      out += ch + next;
      i++;
      continue;
    }
    if ('bfnrtu'.includes(next)) {
      const rest = raw.slice(i + 1);
      if (LATEX_AFTER_ESCAPE.test(rest)) {
        out += '\\\\';
        continue;
      }
      if (next === 'u' && /^u[0-9a-fA-F]{4}/.test(rest)) {
        out += ch;
        continue;
      }
      if (next === 'u') {
        out += '\\\\';
        continue;
      }
      out += ch; // \n \t \r \b \f حقيقية
      continue;
    }
    out += '\\\\'; // مثل \sqrt \pi \leq
  }
  return out;
}

function extractJsonText(input: string): string {
  let t = input.trim().replace(/^\uFEFF/, '');
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  const firstObj = t.indexOf('{');
  const firstArr = t.indexOf('[');
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start === -1) return t;
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  return end > start ? t.slice(start, end + 1) : t.slice(start);
}

type Loose = Record<string, unknown>;

function pickStr(o: Loose, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

const LETTER_INDEX: Record<string, number> = {
  a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, h: 7,
  'أ': 0, 'ب': 1, 'ج': 2, 'د': 3, 'هـ': 4, 'ه': 4, 'و': 5, 'ز': 6, 'ح': 7,
};

export interface ParsedQuiz {
  title: string;
  questions: QuizQuestion[];
  warnings: string[];
  ruleTitle?: string;
  drillStyle?: DrillStyle;
}

export interface ParsedSubQuiz {
  title: string;
  ruleTitle?: string;
  drillStyle?: DrillStyle;
  questions: QuizQuestion[];
  warnings: string[];
}

export interface ParsedQuizBundle {
  title: string;
  questions: QuizQuestion[];
  warnings: string[];
  ruleTitle?: string;
  drillStyle?: DrillStyle;
  subQuizzes: ParsedSubQuiz[];
}

function normalizeDrillStyle(raw: unknown): DrillStyle | undefined {
  const s = String(raw || '').trim();
  if (s === 'same_values' || s === 'same_law_ideas' || s === 'mixed') return s;
  return undefined;
}

function parseQuestionsList(
  rawList: unknown[],
  warnings: string[],
  prefixLabel = ''
): QuizQuestion[] {
  let list = rawList;
  const pfx = prefixLabel ? `${prefixLabel} — ` : '';
  if (list.length > LIMITS.maxQuestions) {
    warnings.push(`${pfx}الملف فيه ${list.length} سؤالاً، وتمت قراءة أول ${LIMITS.maxQuestions} فقط.`);
    list = list.slice(0, LIMITS.maxQuestions);
  }

  const questions: QuizQuestion[] = [];
  list.forEach((item, idx) => {
    const n = idx + 1;
    if (!item || typeof item !== 'object') {
      warnings.push(`${pfx}السؤال ${n}: صيغته غير صالحة وتم تجاهله.`);
      return;
    }
    const o = item as Loose;
    const qText = pickStr(o, ['text', 'question', 'q', 'سؤال', 'السؤال', 'نص']).trim();
    if (!qText) {
      warnings.push(`${pfx}السؤال ${n}: لا يحتوي نصاً وتم تجاهله.`);
      return;
    }

    const rawType = String(o.questionType ?? o.type ?? '').toLowerCase();
    const rawTable = o.table ?? o['جدول'] ?? o['الجدول'];
    const isTable = rawType === 'table' || rawType === 'جدول' || Boolean(rawTable && typeof rawTable === 'object');

    let table: QuizQuestion['table'];
    if (isTable && rawTable !== undefined && rawTable !== null) {
      const pt = parseTableQuestion(rawTable);
      pt.warnings.forEach((w) => warnings.push(`${pfx}السؤال ${n} (الجدول): ${w}`));
      if (pt.table) table = pt.table;
    }

    const rawChoices = o.choices ?? o.options ?? o['خيارات'] ?? o['الخيارات'];
    let choices: string[] = [];
    if (Array.isArray(rawChoices)) {
      choices = rawChoices
        .map((c) => {
          if (typeof c === 'string') return c.trim();
          if (typeof c === 'number') return String(c);
          if (c && typeof c === 'object') return pickStr(c as Loose, ['text', 'label', 'value']).trim();
          return '';
        })
        .filter((c) => c.length > 0);
    }
    if (!isTable && choices.length < 2) {
      warnings.push(`${pfx}السؤال ${n}: الأسئلة باختيارات تحتاج خيارين على الأقل، أضفها وحدد الإجابة الصحيحة أثناء المراجعة.`);
      choices = [];
    }
    if (choices.length > LIMITS.maxChoices) {
      warnings.push(`${pfx}السؤال ${n}: تم الاكتفاء بأول ${LIMITS.maxChoices} خيارات.`);
      choices = choices.slice(0, LIMITS.maxChoices);
    }

    let answer = pickStr(o, ['answer', 'correctAnswer', 'الإجابة', 'الجواب', 'إجابة']).trim();
    let correctIndex = -1;
    const ci = o.correctIndex ?? o.answerIndex ?? o.correct ?? o['الصحيح'];
    if (!isTable && choices.length > 0) {
      if (typeof ci === 'number' && Number.isInteger(ci) && ci >= 0 && ci < choices.length) {
        correctIndex = ci;
      } else if (typeof ci === 'string' && ci.trim()) {
        const s = ci.trim();
        if (/^\d+$/.test(s) && Number(s) >= 0 && Number(s) < choices.length) correctIndex = Number(s);
        else if (s.toLowerCase() in LETTER_INDEX && LETTER_INDEX[s.toLowerCase()] < choices.length)
          correctIndex = LETTER_INDEX[s.toLowerCase()];
        else if (choices.includes(s)) correctIndex = choices.indexOf(s);
      }
      if (correctIndex === -1 && answer) {
        const lower = answer.toLowerCase();
        if (choices.includes(answer)) correctIndex = choices.indexOf(answer);
        else if (lower in LETTER_INDEX && LETTER_INDEX[lower] < choices.length) correctIndex = LETTER_INDEX[lower];
      }
      if (correctIndex === -1) warnings.push(`${pfx}السؤال ${n}: لم تُحدد الإجابة الصحيحة، اخترها أثناء التعديل.`);
      answer = correctIndex >= 0 ? choices[correctIndex] : '';
    }

    const cut = (s: string, max: number, what: string): string => {
      if (s.length > max) {
        warnings.push(`${pfx}السؤال ${n}: ${what} طويل جداً وتم اقتطاعه.`);
        return s.slice(0, max);
      }
      return s;
    };

    let chart: QuizQuestion['chart'];
    const rawChart = o.chart ?? o.graph ?? o['رسم'];
    if (rawChart !== undefined && rawChart !== null) {
      const pc = parseChart(rawChart);
      pc.warnings.forEach((w) => warnings.push(`${pfx}السؤال ${n}: ${w}`));
      if (pc.chart) chart = pc.chart;
    }

    let figure: QuizQuestion['figure'];
    const rawFigure = o.figure ?? o.geometry ?? o.shape ?? o['شكل'];
    if (rawFigure !== undefined && rawFigure !== null) {
      const pf = parseFigure(rawFigure);
      pf.warnings.forEach((w) => warnings.push(`${pfx}السؤال ${n}: ${w}`));
      if (pf.figure) figure = pf.figure;
    }

    let explanationChart: QuizQuestion['explanationChart'];
    const rawExpChart = o.explanationChart;
    if (rawExpChart !== undefined && rawExpChart !== null) {
      const pc = parseChart(rawExpChart);
      pc.warnings.forEach((w) => warnings.push(`${pfx}السؤال ${n} (رسم الشرح): ${w}`));
      if (pc.chart) explanationChart = pc.chart;
    }

    let explanationFigure: QuizQuestion['explanationFigure'];
    const rawExpFigure = o.explanationFigure;
    if (rawExpFigure !== undefined && rawExpFigure !== null) {
      const pf = parseFigure(rawExpFigure);
      pf.warnings.forEach((w) => warnings.push(`${pfx}السؤال ${n} (شكل الشرح): ${w}`));
      if (pf.figure) explanationFigure = pf.figure;
    }

    const explanationTable = o.explanationTable ? sanitizeExplanationTable(o.explanationTable) : null;
    const explanationComparison = o.explanationComparison
      ? sanitizeExplanationComparison(o.explanationComparison)
      : null;

    questions.push({
      id: newQuestionId(),
      questionType: isTable ? 'table' : 'mcq',
      ...(table ? { table } : {}),
      ...(chart ? { chart } : {}),
      ...(figure ? { figure } : {}),
      ...(explanationChart ? { explanationChart } : {}),
      ...(explanationFigure ? { explanationFigure } : {}),
      ...(explanationTable ? { explanationTable } : {}),
      ...(explanationComparison ? { explanationComparison } : {}),
      text: cut(qText, LIMITS.text, 'نص السؤال'),
      choices: isTable ? [] : choices.map((c) => cut(c, LIMITS.choice, 'أحد الخيارات')),
      correctIndex: isTable ? -1 : correctIndex,
      answer: isTable ? '' : cut(answer, LIMITS.answer, 'الإجابة'),
      explanation: cut(pickStr(o, ['explanation', 'شرح', 'الشرح', 'solution']).trim(), LIMITS.explanation, 'الشرح'),
    });
  });

  return questions;
}

export function parseQuizBundleJson(input: string): ParsedQuizBundle {
  if (!input.trim()) throw new Error('الصق محتوى ملف JSON أولاً.');
  const text = sanitizeJsonBackslashes(extractJsonText(input));
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    throw new Error(
      `الملف ليس JSON صالحاً. تأكد أنك نسخت الناتج كاملاً من الذكاء الاصطناعي بدون أي نص إضافي. (${msg.slice(0, 120)})`
    );
  }

  let title = '';
  let list: unknown[] = [];
  let ruleTitle = '';
  let drillStyle: DrillStyle | undefined;
  let rawSubQuizzes: unknown[] = [];

  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === 'object') {
    const o = data as Loose;
    title = pickStr(o, ['title', 'name', 'عنوان', 'العنوان']);
    ruleTitle = pickStr(o, ['ruleTitle', 'rule', 'القاعدة']).trim().slice(0, LIMITS.title);
    drillStyle = normalizeDrillStyle(o.drillStyle ?? o.style);
    const q = o.questions ?? o['الأسئلة'] ?? o.items;
    if (!Array.isArray(q)) throw new Error('لم أجد مصفوفة "questions" داخل الملف.');
    list = q;
    const sub = o.subQuizzes ?? o.drillQuizzes ?? o.drills ?? o['اختبارات_التقوية'] ?? o['التدريبات'];
    if (Array.isArray(sub)) rawSubQuizzes = sub;
  } else {
    throw new Error('صيغة الملف غير معروفة: يجب أن يكون كائناً فيه "questions".');
  }

  const warnings: string[] = [];
  if (list.length === 0) throw new Error('الملف لا يحتوي أي سؤال.');

  const questions = parseQuestionsList(list, warnings);
  if (questions.length === 0) throw new Error('لم أستطع قراءة أي سؤال صالح من الملف.');

  const subQuizzes: ParsedSubQuiz[] = [];
  rawSubQuizzes.forEach((rawSub, idx) => {
    if (!rawSub || typeof rawSub !== 'object') return;
    const so = rawSub as Loose;
    const subTitle =
      pickStr(so, ['title', 'name', 'عنوان']).trim().slice(0, LIMITS.title) ||
      `تدريب تقوية #${idx + 1}`;
    const subList = so.questions ?? so['الأسئلة'] ?? so.items;
    if (!Array.isArray(subList) || subList.length === 0) return;
    const subWarnings: string[] = [];
    const subQuestions = parseQuestionsList(subList, subWarnings, subTitle);
    if (subQuestions.length === 0) return;
    subWarnings.forEach((w) => warnings.push(w));
    const subRule = pickStr(so, ['ruleTitle', 'rule', 'القاعدة']).trim().slice(0, LIMITS.title);
    const subStyle = normalizeDrillStyle(so.drillStyle ?? so.style);
    subQuizzes.push({
      title: subTitle,
      ...(subRule ? { ruleTitle: subRule } : {}),
      ...(subStyle ? { drillStyle: subStyle } : {}),
      questions: subQuestions,
      warnings: subWarnings,
    });
  });

  return {
    title: title.trim().slice(0, LIMITS.title),
    questions,
    warnings,
    ...(ruleTitle ? { ruleTitle } : {}),
    ...(drillStyle ? { drillStyle } : {}),
    subQuizzes,
  };
}

export function parseQuizJson(input: string): ParsedQuiz {
  const b = parseQuizBundleJson(input);
  return {
    title: b.title,
    questions: b.questions,
    warnings: b.warnings,
    ...(b.ruleTitle ? { ruleTitle: b.ruleTitle } : {}),
    ...(b.drillStyle ? { drillStyle: b.drillStyle } : {}),
  };
}

function serializeQuestionForExport(q: QuizQuestion) {
  return {
    questionType: q.questionType === 'table' || q.table ? 'table' : 'mcq',
    text: q.text,
    ...(q.table ? { table: q.table } : {}),
    choices: q.choices,
    correctIndex: q.correctIndex,
    answer: q.answer,
    explanation: q.explanation,
    ...(q.chart ? { chart: q.chart } : {}),
    ...(q.figure ? { figure: q.figure } : {}),
    ...(q.explanationChart ? { explanationChart: q.explanationChart } : {}),
    ...(q.explanationFigure ? { explanationFigure: q.explanationFigure } : {}),
    ...(q.explanationTable ? { explanationTable: q.explanationTable } : {}),
    ...(q.explanationComparison ? { explanationComparison: q.explanationComparison } : {}),
  };
}

export function quizToExportJson(
  title: string,
  questions: QuizQuestion[],
  childDrills: MyQuiz[] = []
): string {
  return JSON.stringify(
    {
      title,
      questions: questions.map(serializeQuestionForExport),
      ...(childDrills.length > 0
        ? {
            subQuizzes: childDrills.map((sub) => ({
              title: sub.title,
              ...(sub.ruleTitle ? { ruleTitle: sub.ruleTitle } : {}),
              ...(sub.drillStyle ? { drillStyle: sub.drillStyle } : {}),
              questions: sub.questions.map(serializeQuestionForExport),
            })),
          }
        : {}),
    },
    null,
    2
  );
}

/* ------------------------------------------------------------------ */
/*  التحقق والحفظ في Firestore                                         */
/* ------------------------------------------------------------------ */

export function cleanQuestions(questions: QuizQuestion[]): QuizQuestion[] {
  const out: QuizQuestion[] = [];
  for (const q of questions) {
    const text = q.text.trim();
    if (!text) continue;
    const isTable = q.questionType === 'table' || Boolean(q.table && !q.choices?.length);
    const table = q.table ? sanitizeTableQuestion(q.table) : null;
    const keep = (q.choices || []).map((c, i) => ({ c: c.trim(), i })).filter((x) => x.c.length > 0);
    const choices = isTable ? [] : keep.map((x) => x.c).slice(0, LIMITS.maxChoices);
    let correctIndex = isTable ? -1 : keep.findIndex((x) => x.i === q.correctIndex);
    if (!isTable && (choices.length < 2 || correctIndex < 0 || correctIndex >= choices.length)) correctIndex = -1;
    const finalChoices = !isTable && choices.length >= 2 ? choices : [];
    const chart = q.chart ? sanitizeChart(q.chart) : null;
    const figure = q.figure ? sanitizeFigure(q.figure) : null;
    const explanationChart = q.explanationChart ? sanitizeChart(q.explanationChart) : null;
    const explanationFigure = q.explanationFigure ? sanitizeFigure(q.explanationFigure) : null;
    const explanationTable = q.explanationTable ? sanitizeExplanationTable(q.explanationTable) : null;
    const explanationComparison = q.explanationComparison
      ? sanitizeExplanationComparison(q.explanationComparison)
      : null;

    out.push({
      id: q.id,
      ...(isTable ? { questionType: 'table' as const } : {}),
      ...(table && isTable ? { table } : {}),
      ...(chart ? { chart } : {}),
      ...(figure ? { figure } : {}),
      ...(explanationChart ? { explanationChart } : {}),
      ...(explanationFigure ? { explanationFigure } : {}),
      ...(explanationTable ? { explanationTable } : {}),
      ...(explanationComparison ? { explanationComparison } : {}),
      text: text.slice(0, LIMITS.text),
      choices: finalChoices,
      correctIndex: !isTable && finalChoices.length ? correctIndex : -1,
      answer: !isTable && finalChoices.length && correctIndex >= 0 ? finalChoices[correctIndex].slice(0, LIMITS.answer) : '',
      explanation: q.explanation.trim().slice(0, LIMITS.explanation),
    });
  }
  return out;
}

export function validateForSave(title: string, questions: QuizQuestion[]): string | null {
  if (!title.trim()) return 'اكتب عنواناً مناسباً للاختبار.';
  if (title.trim().length > LIMITS.title) return `العنوان أطول من ${LIMITS.title} حرفاً.`;
  const cleaned = cleanQuestions(questions);
  if (cleaned.length === 0) return 'أضف سؤالاً واحداً على الأقل (نص السؤال لا يمكن أن يكون فارغاً).';
  let num = 0;
  for (const q of questions) {
    if (!q.text.trim()) continue;
    num++;
    const isTable = q.questionType === 'table' || Boolean(q.table && !q.choices?.length);
    if (isTable) {
      const prob = tableQuestionProblem(q.table);
      if (prob) return `السؤال ${num} (الجدول): ${prob}`;
    } else {
      const filled = q.choices.map((c, i) => ({ c: c.trim(), i })).filter((x) => x.c.length > 0);
      if (filled.length < 2) return `السؤال ${num}: أضف خيارين على الأقل.`;
      if (!filled.some((x) => x.i === q.correctIndex)) return `السؤال ${num}: حدد الإجابة الصحيحة بالضغط على علامة ✓ بجانب الخيار.`;
    }
    if (q.chart) {
      const prob = chartProblem(q.chart);
      if (prob) return `السؤال ${num} (الرسم البياني): ${prob}`;
    }
    if (q.figure) {
      const prob = figureProblem(q.figure);
      if (prob) return `السؤال ${num} (الشكل الهندسي): ${prob}`;
    }
    if (q.explanationChart) {
      const prob = chartProblem(q.explanationChart);
      if (prob) return `السؤال ${num} (رسم الشرح): ${prob}`;
    }
    if (q.explanationFigure) {
      const prob = figureProblem(q.explanationFigure);
      if (prob) return `السؤال ${num} (شكل الشرح): ${prob}`;
    }
  }
  if (cleaned.length > LIMITS.maxQuestions) return `الحد الأقصى ${LIMITS.maxQuestions} سؤال.`;
  const bytes = new TextEncoder().encode(JSON.stringify(cleaned)).length;
  if (bytes > LIMITS.maxBytes) return 'حجم الاختبار كبير جداً، قسّمه إلى اختبارين.';
  return null;
}

export interface MyQuizMetaInput {
  parentQuizId?: string;
  quizKind?: 'main' | 'drill';
  drillStyle?: DrillStyle;
  sourceStarredId?: string;
  ruleTitle?: string;
}

function buildQuizMetaPayload(meta?: MyQuizMetaInput): Record<string, unknown> {
  if (!meta) return {};
  return {
    ...(meta.parentQuizId ? { parentQuizId: String(meta.parentQuizId).slice(0, 128) } : {}),
    ...(meta.quizKind === 'main' || meta.quizKind === 'drill' ? { quizKind: meta.quizKind } : {}),
    ...(meta.drillStyle === 'same_values' ||
    meta.drillStyle === 'same_law_ideas' ||
    meta.drillStyle === 'mixed'
      ? { drillStyle: meta.drillStyle }
      : {}),
    ...(meta.sourceStarredId ? { sourceStarredId: String(meta.sourceStarredId).slice(0, 128) } : {}),
    ...(meta.ruleTitle ? { ruleTitle: String(meta.ruleTitle).slice(0, 120) } : {}),
  };
}

export async function createMyQuiz(
  uid: string,
  title: string,
  questions: QuizQuestion[],
  meta?: MyQuizMetaInput
): Promise<string> {
  const id = newQuizId();
  const cleaned = cleanQuestions(questions);
  const path = `users/${uid}/myQuizzes/${id}`;
  const metaPayload = buildQuizMetaPayload(meta);
  if (Object.keys(metaPayload).length > 0 && meta) {
    await saveMyQuizMetaOverride(uid, id, meta);
  }
  const coreDoc = {
    id,
    ownerId: uid,
    title: title.trim().slice(0, LIMITS.title),
    questions: cleaned,
    questionCount: cleaned.length,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  try {
    await setDoc(doc(db, 'users', uid, 'myQuizzes', id), {
      ...coreDoc,
      ...metaPayload,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/permission-denied|permission_denied/i.test(msg) && Object.keys(metaPayload).length > 0) {
      notifyRulesUpdateNeeded();
      try {
        await setDoc(doc(db, 'users', uid, 'myQuizzes', id), coreDoc);
        return id;
      } catch (fallbackErr) {
        handleFirestoreError(fallbackErr, OperationType.CREATE, path);
      }
    }
    handleFirestoreError(err, OperationType.CREATE, path);
  }
  return id;
}

export async function updateMyQuiz(
  uid: string,
  id: string,
  title: string,
  questions: QuizQuestion[],
  meta?: MyQuizMetaInput
): Promise<void> {
  const cleaned = cleanQuestions(questions);
  const path = `users/${uid}/myQuizzes/${id}`;
  const metaPayload = buildQuizMetaPayload(meta);
  if (Object.keys(metaPayload).length > 0 && meta) {
    await saveMyQuizMetaOverride(uid, id, meta);
  }
  const coreUpdate = {
    title: title.trim().slice(0, LIMITS.title),
    questions: cleaned,
    questionCount: cleaned.length,
    updatedAt: serverTimestamp(),
  };
  try {
    await updateDoc(doc(db, 'users', uid, 'myQuizzes', id), {
      ...coreUpdate,
      ...metaPayload,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/permission-denied|permission_denied/i.test(msg) && Object.keys(metaPayload).length > 0) {
      notifyRulesUpdateNeeded();
      try {
        await updateDoc(doc(db, 'users', uid, 'myQuizzes', id), coreUpdate);
        return;
      } catch (fallbackErr) {
        handleFirestoreError(fallbackErr, OperationType.UPDATE, path);
      }
    }
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteMyQuiz(uid: string, id: string): Promise<void> {
  const path = `users/${uid}/myQuizzes/${id}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'myQuizzes', id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}
