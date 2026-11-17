import { deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import type { QuizQuestion } from './types';
import { chartProblem, parseChart, sanitizeChart } from './quizChart';
import { figureProblem, parseFigure, sanitizeFigure } from './quizFigure';

export const LIMITS = {
  maxQuestions: 100,
  title: 120,
  text: 2000,
  choice: 500,
  maxChoices: 8,
  answer: 1000,
  explanation: 2000,
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

export function emptyQuestion(): QuizQuestion {
  return { id: newQuestionId(), text: '', choices: ['', '', '', ''], correctIndex: -1, answer: '', explanation: '' };
}

/* ------------------------------------------------------------------ */
/*  سكريبت الذكاء الاصطناعي الذي ينسخه المستخدم قبل الاستيراد         */
/* ------------------------------------------------------------------ */

export const IMPORT_PROMPT = String.raw`أنت مساعد خبير في إعداد الاختبارات الرياضية والعلمية والهندسية. حوّل المادة التي سأعطيك إياها إلى اختبار، وأخرج الناتج على شكل "ملف JSON واحد فقط" داخل كتلة كود واحدة، بدون أي شرح أو كلام قبله أو بعده، وبالشكل التالي بالضبط:

{
  "title": "عنوان مناسب ومختصر للاختبار",
  "questions": [
    {
      "text": "نص السؤال (يدعم الرياضيات بصيغة LaTeX مثل $\\frac{3}{4}$ و $\\sqrt{16}$)",
      "choices": ["الخيار الأول", "الخيار الثاني", "الخيار الثالث", "الخيار الرابع"],
      "correctIndex": 1,
      "explanation": "شرح الحل بالتفصيل خطوة بخطوة مع المعادلات والرموز (اختياري)"
    },
    {
      "text": "في الشكل المجاور: مستقيمان متقاطعان في النقطة م، ما قيمة $س$؟",
      "figure": {
        "title": "زوايا متقابلة بالرأس",
        "points": [
          { "id": "M", "x": 0, "y": 0, "label": "م", "dot": true, "labelPos": "bottom" },
          { "id": "A", "x": -5, "y": -2.2, "label": "أ" },
          { "id": "B", "x": 5, "y": 2.2, "label": "ب" },
          { "id": "C", "x": -3.6, "y": 3.4, "label": "ج" },
          { "id": "D", "x": 3.6, "y": -3.4, "label": "د" }
        ],
        "elements": [
          { "type": "segment", "from": "A", "to": "B", "extendFrom": true, "extendTo": true, "stroke": "ink" },
          { "type": "segment", "from": "C", "to": "D", "extendFrom": true, "extendTo": true, "stroke": "ink" },
          { "type": "angle", "a": "C", "vertex": "M", "b": "B", "label": "115°", "color": "blue", "arcs": 1, "r": 1.4 },
          { "type": "angle", "a": "A", "vertex": "M", "b": "D", "label": "2س + 15°", "color": "red", "arcs": 1, "r": 1.4 }
        ]
      },
      "choices": ["$40$", "$50$", "$57.5$", "$65$"],
      "correctIndex": 1,
      "explanation": "الزاويتان متقابلتان بالرأس لذا فهما متساويتان:\n$2س + 15^{\\circ} = 115^{\\circ}$\n$2س = 100^{\\circ} \\Rightarrow س = \\frac{100}{2} = 50$"
    }
  ]
}

القواعد الصارمة (التزم بها حرفياً ولا تخرج عنها بتاتاً):
1) الناتج JSON صالح 100%: علامات اقتباس مزدوجة فقط، بدون فواصل زائدة، بدون تعليقات، بدون أي نص خارج الكتلة.
2) title: عنوان قصير مناسب. questions: مصفوفة بحد أقصى 100 سؤال.
3) كل الأسئلة اختيار من متعدد بدون استثناء:
   - text: نص السؤال (إلزامي).
   - choices: مصفوفة من 2 إلى 8 خيارات (يفضّل 4 خيارات متقاربة الطول).
   - correctIndex: رقم الخيار الصحيح يبدأ من 0 (0، 1، 2، 3...). وزّع مواضع الإجابة الصحيحة بين 0 و1 و2 و3 ولا تجعلها ثابتة.
   - explanation: شرح الحل خطوة بخطوة (يُعرض للطالب بعد الإجابة). يُمكن أن يحتوي أسطراً متعددة (\n) ومعادلات وكسوراً وجذوراً بصيغة $...$، ويمكن أيضاً إرفاق "explanationChart" أو "explanationFigure" اختيارياً داخل السؤال إذا احتاج الشرح نفسه رسماً توضيحياً!
4) تحقق الحساب: احسب الإجابة بدقة بنفسك أولاً، ثم رتب الخيارات، ثم ضع في correctIndex موضع الإجابة الصحيحة وتأكد أن choices[correctIndex] صحيح 100%.

5) الأشكال الهندسية المتجهية (figure — مهم جداً للأسئلة الهندسية البسيطة والمركّبة):
   متى تستخدمها؟ كلما احتاج السؤال مثلثاً، مربعاً، مستطيلاً، دائرة، قطاعاً، مضلعاً منتظماً، زوايا متقابلة بالرأس، مستقيمات متوازية وقاطعاً، زاوية خارجية، دائرة داخل مربع (مناطق مظللة)، أو أشكالاً هندسية مركبة بأطوال أو زوايا أو مجاهيل مثل س أو ص أو x أو 2س + 10°.
   يرسم البرنامج الشكل بدقة هندسية من الإحداثيات! فلا تكتب صورة ولا رابطاً.
   نظام الإحداثيات: ديكارتي رياضي قياسي (Y للأعلى): x يزيد لليمين، و y يزيد للأعلى، والزاوية 0° لليمين و90° للأعلى.
   البنية الدقيقة للكائن "figure":
   {
     "title": "عنوان الشكل (اختياري)",
     "caption": "ملاحظة قصيرة أسفل الشكل (اختياري)",
     "grid": false,
     "points": [
       { "id": "A", "x": 0, "y": 4, "label": "أ", "labelPos": "top", "dot": true }
     ],
     "elements": [ ... ]
   }
   - الحقول المسموحة داخل كل نقطة في points:
     • id: معرّف إنجليزي قصير وفريد ("A","B","C","M","O"...).
     • x, y: أرقام حقيقية دقيقة هندسياً (تأكد من تطابق النسب والتماس والاستقامة).
     • label: الاسم الظاهر على الرسم ("أ"، "ب"، "م"، أو "" لإخفائه).
     • labelPos (اختياري): "auto" | "top" | "bottom" | "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right".
     • dot (اختياري): true لإظهار نقطة سوداء صغيرة واضحة.
   - الألوان المعتمدة في fill / stroke / color هي إحدى الكلمات الإنجليزية فقط:
     "ink" (أسود داكن) | "blue" (أزرق) | "green" (أخضر) | "gold" (ذهبي) | "purple" (بنفسجي) | "red" (أحمر) | "gray" (رمادي) | "white" (أبيض للتفريغ) | "none" (شفاف لـ fill فقط).

   أنواع العناصر الستة داخل "elements" (التزم بأسماء الحقول بدقة):
   أ) مضلع ("polygon"): مثلث، مربع، مستطيل، معين، شبه منحرف، سداسي...
      { "type": "polygon", "points": ["A","B","C"], "fill": "blue", "fillOpacity": 0.16, "stroke": "ink", "dashed": false, "sideLabels": ["3 سم", "4 سم", "س"], "ticks": [1, 1, 0] }
      • sideLabels (اختياري): مصفوفة بنفس عدد رؤوس المضلع (الترتيب: الضلع بين points[0]-points[1] ثم [1]-[2]... والأخير بين [n-1]-[0]؛ اترك "" للضلع بلا تسمية).
      • ticks (اختياري): شرطة التطابق (1 أو 2 أو 3 أو 0) على كل ضلع بنفس الترتيب.
   ب) قطعة / مستقيم / شعاع ("segment"):
      { "type": "segment", "from": "A", "to": "B", "extendFrom": true, "extendTo": true, "stroke": "ink", "dashed": false, "label": "5 سم", "ticks": 1, "parallel": 1 }
      • extendFrom: true يمدّ الخط بسهم من جهة from، و extendTo: true يمده بسهم من جهة to (للمستقيم الممتد ضعهما true، وللشعاع ضع extendTo: true).
      • parallel: 1 أو 2 يرسم أسهم التوازي (› أو ››) على المستقيمات المتوازية!
   ج) دائرة ("circle"):
      { "type": "circle", "center": "O", "r": 3, "fill": "none", "fillOpacity": 0.2, "stroke": "ink", "dashed": false, "showCenter": true, "radiusAngleDeg": 0, "radiusLabel": "نق = 5", "diameterAngleDeg": 90, "diameterLabel": "ق = 10" }
   د) قوس أو قطاع دائري ("arc"):
      { "type": "arc", "center": "O", "r": 4, "startDeg": 0, "endDeg": 60, "sector": true, "fill": "gold", "fillOpacity": 0.45, "stroke": "gold", "label": "طول القوس" }
   هـ) زاوية ("angle"):
      { "type": "angle", "a": "B", "vertex": "A", "b": "C", "label": "س°", "right": false, "arcs": 1, "reflex": false, "color": "red", "r": 1.2 }
      • يرسم القوس الأصغر (≤180°) تلقائياً عند الرأس vertex بين الضلعين vertex→a و vertex→b (وللزوايا المنعكسة >180° أضف "reflex": true).
      • للزاوية القائمة 90° ضع "right": true فيرسم مربع التعامد بدقة!
      • arcs (1 أو 2 أو 3): يرسم قوساً أو قوسين أو ثلاثة للتمييز بين الزوايا المتساوية والمختلفة.
      • لا تضع قياس الزاوية الحقيقي في الجواب إذا كان مطلوباً إيجاده؛ اكتب مكانه "س°" أو "2س + 10°" أو "x".
   و) نص حر ("label"):
      { "type": "label", "x": 3, "y": 5.5, "text": "الجزء المظلل", "color": "blue" }

   نماذج إحداثيات جاهزة للأشكال المعقدة (اتبع نفس المنطق الرياضي):
   • تقاطع مستقيمين (زوايا متقابلة بالرأس): ضع المركز M=(0,0)، والنقطتين A=(-5,-2) و B=(5,2) على خط واحد (يمران بـ M لأن المجموع 0)، والنقطتين C=(-3,4) و D=(3,-4) على الخط الثاني، مع extendFrom:true و extendTo:true. الزاويتان المتقابلتان هما angle(C,M,B) و angle(A,M,D).
   • مستقيمان متوازيان وقاطع: ضع المستقيم العلوي y=3 من (-5,3) إلى (6,3) والمستقيم السفلي y=0 من (-5,0) إلى (6,0) كلاهما مع "parallel": 1. القاطع يمر بنقطتين تحققهما نفس معادلة الخط المستقيم (مثلاً من T1=(-1.5,5) إلى P=(0,3) إلى Q=(2.25,0) إلى T2=(3.75,-2) — لاحظ ثبات الميل Δy/Δx = -4/3 على كل النقاط!).
   • زاوية خارجية لمثلث: اجعل B=(0,0)، C=(5,0)، D=(8.5,0) على استقامة واحدة أفقياً، و A=(2.5,4)، فارسم triangle(A,B,C) و segment(C,D) بـ extendTo:true، والزاوية الخارجية هي angle(A,C,D).
   • منطقة مظللة (دائرة داخل مربع مثلاً): ضع مربعاً من (0,0) إلى (6,6) بـ fill:"blue", fillOpacity:0.35، ثم ارسم بعده مباشرة في elements دائرة مركزها O=(3,3) ونصف قطرها r=3 بـ "fill": "white", "fillOpacity": 1! الترتيب واللون "white" يفرّغ الدائرة ويُبقي أركان المربع الأربعة مظللة بدقة متناهية!

6) الرسوم البيانية (chart — اختيارية): إن احتاج السؤال إلى أعمدة أو خط بياني أو دائرة نسب، أضف الحقل "chart":
   "chart": {
     "type": "bar",
     "title": "عنوان الرسم (اختياري)",
     "xLabel": "المحور الأفقي",
     "yLabel": "المحور الرأسي",
     "labels": ["أ", "ب", "ج"],
     "series": [ { "name": "السلسلة", "values": [10, 25, 18] } ]
   }
   - type أحد أربعة فقط: "bar" أعمدة رأسية، "hbar" أعمدة أفقية، "line" خط بياني، "pie" رسم دائري.
   - عدد القيم values يجب أن يساوي عدد labels تماماً، وتكون أرقاماً صافية بلا اقتباس.

7) الرياضيات والرموز (داخل text و choices و explanation):
   ضع كل تعبير رياضي بين $...$ بصيغة LaTeX:
   - كسر: $\\frac{3}{4}$   | جذر تربيعي: $\\sqrt{x}$   | جذر تكعيبي: $\\sqrt[3]{x}$
   - أس: $x^{2}$ ، $2^{n+1}$ | دليل: $x_{1}$ | درجة: $90^{\\circ}$
   - رموز: $\\times$ ، $\\div$ ، $\\pm$ ، $\\leq$ ، $\\geq$ ، $\\neq$ ، $\\approx$ ، $\\pi$ ، $\\infty$ ، $\\theta$ ، $\\alpha$ ، $\\beta$ ، $\\Delta$ ، $\\angle$ ، $\\triangle$ ، $\\perp$ ، $\\parallel$ ، $\\Rightarrow$
   - قاعدة JSON للشرطة المائلة: يجب كتابة كل شرطة مائلة مرتين "\\" داخل النص مثل "$\\frac{1}{2}$" و "$\\sqrt{49}$". للسطر الجديد داخل explanation اكتب "\n".
   - لا تستخدم Markdown أو HTML مثل ** أو <br>.

المادة المطلوب تحويلها إلى اختبار:
(الصق هنا المادة أو الأسئلة أو أرفق الملف)`;

/** مثال كامل جاهز للتجربة داخل شاشة الاستيراد (رياضيات + هندسة مركبة + رسوم بيانية + شرح مفصل) */
export const EXAMPLE_JSON = JSON.stringify(
  {
    title: 'مثال: الهندسة والرياضيات والرسوم البيانية',
    questions: [
      {
        text: 'ما قيمة $\\sqrt{49} + \\frac{1}{2}$ ؟',
        choices: ['$7.5$', '$7$', '$8$', '$6.5$'],
        correctIndex: 0,
        explanation: 'أولاً نحسب الجذر: $\\sqrt{49} = 7$\nثم نضيف الكسر: $7 + \\frac{1}{2} = 7.5$',
      },
      {
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
          'بما أن الزاويتين متقابلتان بالرأس فهما متساويتان:\n$2س + 15^{\\circ} = 115^{\\circ}$\n$2س = 115^{\\circ} - 15^{\\circ} = 100^{\\circ}$\n$س = \\frac{100}{2} = 50$',
      },
      {
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
          'مساحة المربع $= 10 \\times 10 = 100\\text{ سم}^{2}$\nطول نصف قطر الدائرة $\\text{نق} = \\frac{10}{2} = 5\\text{ سم}$\nمساحة الدائرة $= \\pi \\times \\text{نق}^{2} = 3.14 \\times 5^{2} = 78.5\\text{ سم}^{2}$\nمساحة المنطقة المظللة $= 100 - 78.5 = 21.5\\text{ سم}^{2}$',
      },
      {
        text: 'حسب الرسم، في أي شهر كانت المبيعات الأعلى؟',
        chart: {
          type: 'bar',
          title: 'مبيعات المتجر',
          xLabel: 'الشهر',
          yLabel: 'عدد القطع',
          labels: ['يناير', 'فبراير', 'مارس'],
          series: [{ name: 'المبيعات', values: [10, 25, 18] }],
        },
        choices: ['يناير', 'فبراير', 'مارس', 'لا يمكن التحديد'],
        correctIndex: 1,
        explanation: 'أعلى عمود هو شهر فبراير بقيمة $25$ قطعة.',
      },
      {
        text: 'ما نسبة من اختار "كرة القدم" إلى المجموع؟',
        chart: {
          type: 'pie',
          title: 'الرياضة المفضلة',
          labels: ['كرة القدم', 'السباحة', 'الجري'],
          series: [{ name: 'عدد الطلاب', values: [50, 30, 20] }],
        },
        choices: ['$20\\%$', '$30\\%$', '$50\\%$', '$60\\%$'],
        correctIndex: 2,
        explanation: 'المجموع $= 50 + 30 + 20 = 100$، فتكون النسبة $= \\frac{50}{100} = 50\\%$',
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
}

export function parseQuizJson(input: string): ParsedQuiz {
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
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === 'object') {
    const o = data as Loose;
    title = pickStr(o, ['title', 'name', 'عنوان', 'العنوان']);
    const q = o.questions ?? o['الأسئلة'] ?? o.items;
    if (!Array.isArray(q)) throw new Error('لم أجد مصفوفة "questions" داخل الملف.');
    list = q;
  } else {
    throw new Error('صيغة الملف غير معروفة: يجب أن يكون كائناً فيه "questions".');
  }

  const warnings: string[] = [];
  if (list.length === 0) throw new Error('الملف لا يحتوي أي سؤال.');
  if (list.length > LIMITS.maxQuestions) {
    warnings.push(`الملف فيه ${list.length} سؤالاً، وتمت قراءة أول ${LIMITS.maxQuestions} فقط.`);
    list = list.slice(0, LIMITS.maxQuestions);
  }

  const questions: QuizQuestion[] = [];
  list.forEach((item, idx) => {
    const n = idx + 1;
    if (!item || typeof item !== 'object') {
      warnings.push(`السؤال ${n}: صيغته غير صالحة وتم تجاهله.`);
      return;
    }
    const o = item as Loose;
    const qText = pickStr(o, ['text', 'question', 'q', 'سؤال', 'السؤال', 'نص']).trim();
    if (!qText) {
      warnings.push(`السؤال ${n}: لا يحتوي نصاً وتم تجاهله.`);
      return;
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
    if (choices.length < 2) {
      warnings.push(`السؤال ${n}: كل الأسئلة يجب أن تكون باختيارات (خياران على الأقل)، أضفها وحدد الإجابة الصحيحة أثناء المراجعة.`);
      choices = [];
    }
    if (choices.length > LIMITS.maxChoices) {
      warnings.push(`السؤال ${n}: تم الاكتفاء بأول ${LIMITS.maxChoices} خيارات.`);
      choices = choices.slice(0, LIMITS.maxChoices);
    }

    let answer = pickStr(o, ['answer', 'correctAnswer', 'الإجابة', 'الجواب', 'إجابة']).trim();
    let correctIndex = -1;
    const ci = o.correctIndex ?? o.answerIndex ?? o.correct ?? o['الصحيح'];
    if (choices.length > 0) {
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
      if (correctIndex === -1) warnings.push(`السؤال ${n}: لم تُحدد الإجابة الصحيحة، اخترها أثناء التعديل.`);
      answer = correctIndex >= 0 ? choices[correctIndex] : '';
    }

    const cut = (s: string, max: number, what: string): string => {
      if (s.length > max) {
        warnings.push(`السؤال ${n}: ${what} طويل جداً وتم اقتطاعه.`);
        return s.slice(0, max);
      }
      return s;
    };

    let chart: QuizQuestion['chart'];
    const rawChart = o.chart ?? o.graph ?? o['رسم'];
    if (rawChart !== undefined && rawChart !== null) {
      const pc = parseChart(rawChart);
      pc.warnings.forEach((w) => warnings.push(`السؤال ${n}: ${w}`));
      if (pc.chart) chart = pc.chart;
    }

    let figure: QuizQuestion['figure'];
    const rawFigure = o.figure ?? o.geometry ?? o.shape ?? o['شكل'];
    if (rawFigure !== undefined && rawFigure !== null) {
      const pf = parseFigure(rawFigure);
      pf.warnings.forEach((w) => warnings.push(`السؤال ${n}: ${w}`));
      if (pf.figure) figure = pf.figure;
    }

    let explanationChart: QuizQuestion['explanationChart'];
    const rawExpChart = o.explanationChart;
    if (rawExpChart !== undefined && rawExpChart !== null) {
      const pc = parseChart(rawExpChart);
      pc.warnings.forEach((w) => warnings.push(`السؤال ${n} (رسم الشرح): ${w}`));
      if (pc.chart) explanationChart = pc.chart;
    }

    let explanationFigure: QuizQuestion['explanationFigure'];
    const rawExpFigure = o.explanationFigure;
    if (rawExpFigure !== undefined && rawExpFigure !== null) {
      const pf = parseFigure(rawExpFigure);
      pf.warnings.forEach((w) => warnings.push(`السؤال ${n} (شكل الشرح): ${w}`));
      if (pf.figure) explanationFigure = pf.figure;
    }

    questions.push({
      id: newQuestionId(),
      ...(chart ? { chart } : {}),
      ...(figure ? { figure } : {}),
      ...(explanationChart ? { explanationChart } : {}),
      ...(explanationFigure ? { explanationFigure } : {}),
      text: cut(qText, LIMITS.text, 'نص السؤال'),
      choices: choices.map((c) => cut(c, LIMITS.choice, 'أحد الخيارات')),
      correctIndex,
      answer: cut(answer, LIMITS.answer, 'الإجابة'),
      explanation: cut(pickStr(o, ['explanation', 'شرح', 'الشرح', 'solution']).trim(), LIMITS.explanation, 'الشرح'),
    });
  });

  if (questions.length === 0) throw new Error('لم أستطع قراءة أي سؤال صالح من الملف.');
  return { title: title.trim().slice(0, LIMITS.title), questions, warnings };
}

export function quizToExportJson(title: string, questions: QuizQuestion[]): string {
  return JSON.stringify(
    {
      title,
      questions: questions.map((q) => ({
        text: q.text,
        choices: q.choices,
        correctIndex: q.correctIndex,
        answer: q.answer,
        explanation: q.explanation,
        ...(q.chart ? { chart: q.chart } : {}),
        ...(q.figure ? { figure: q.figure } : {}),
        ...(q.explanationChart ? { explanationChart: q.explanationChart } : {}),
        ...(q.explanationFigure ? { explanationFigure: q.explanationFigure } : {}),
      })),
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
    const keep = q.choices.map((c, i) => ({ c: c.trim(), i })).filter((x) => x.c.length > 0);
    const choices = keep.map((x) => x.c).slice(0, LIMITS.maxChoices);
    let correctIndex = keep.findIndex((x) => x.i === q.correctIndex);
    if (choices.length < 2 || correctIndex < 0 || correctIndex >= choices.length) correctIndex = -1;
    const finalChoices = choices.length >= 2 ? choices : [];
    const chart = q.chart ? sanitizeChart(q.chart) : null;
    const figure = q.figure ? sanitizeFigure(q.figure) : null;
    const explanationChart = q.explanationChart ? sanitizeChart(q.explanationChart) : null;
    const explanationFigure = q.explanationFigure ? sanitizeFigure(q.explanationFigure) : null;
    out.push({
      id: q.id,
      ...(chart ? { chart } : {}),
      ...(figure ? { figure } : {}),
      ...(explanationChart ? { explanationChart } : {}),
      ...(explanationFigure ? { explanationFigure } : {}),
      text: text.slice(0, LIMITS.text),
      choices: finalChoices,
      correctIndex: finalChoices.length ? correctIndex : -1,
      answer: (finalChoices.length && correctIndex >= 0 ? finalChoices[correctIndex] : q.answer.trim()).slice(
        0,
        LIMITS.answer
      ),
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
    const filled = q.choices.map((c, i) => ({ c: c.trim(), i })).filter((x) => x.c.length > 0);
    if (filled.length < 2) return `السؤال ${num}: أضف خيارين على الأقل (كل الأسئلة باختيارات).`;
    if (!filled.some((x) => x.i === q.correctIndex)) return `السؤال ${num}: حدد الإجابة الصحيحة بالضغط على علامة ✓ بجانب الخيار.`;
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

export async function createMyQuiz(uid: string, title: string, questions: QuizQuestion[]): Promise<string> {
  const id = newQuizId();
  const cleaned = cleanQuestions(questions);
  const path = `users/${uid}/myQuizzes/${id}`;
  try {
    await setDoc(doc(db, 'users', uid, 'myQuizzes', id), {
      id,
      ownerId: uid,
      title: title.trim().slice(0, LIMITS.title),
      questions: cleaned,
      questionCount: cleaned.length,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
  return id;
}

export async function updateMyQuiz(
  uid: string,
  id: string,
  title: string,
  questions: QuizQuestion[]
): Promise<void> {
  const cleaned = cleanQuestions(questions);
  const path = `users/${uid}/myQuizzes/${id}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'myQuizzes', id), {
      title: title.trim().slice(0, LIMITS.title),
      questions: cleaned,
      questionCount: cleaned.length,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
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
