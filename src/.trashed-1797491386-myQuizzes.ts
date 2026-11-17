import { deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import type { QuizQuestion } from './types';

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
  return { id: newQuestionId(), text: '', choices: [], correctIndex: -1, answer: '', explanation: '' };
}

/* ------------------------------------------------------------------ */
/*  سكريبت الذكاء الاصطناعي الذي ينسخه المستخدم قبل الاستيراد         */
/* ------------------------------------------------------------------ */

export const IMPORT_PROMPT = String.raw`أنت مساعد متخصص في إعداد الاختبارات. حوّل المادة التي سأعطيك إياها إلى اختبار، وأخرج الناتج على شكل "ملف JSON واحد فقط" داخل كتلة كود واحدة، بدون أي شرح أو كلام قبله أو بعده، وبالشكل التالي بالضبط:

{
  "title": "عنوان مناسب ومختصر للاختبار",
  "questions": [
    {
      "text": "نص السؤال الاختياري",
      "choices": ["الخيار الأول", "الخيار الثاني", "الخيار الثالث", "الخيار الرابع"],
      "correctIndex": 0,
      "explanation": "شرح مختصر للحل (اختياري)"
    },
    {
      "text": "سؤال مقالي بدون خيارات",
      "choices": [],
      "answer": "الإجابة النموذجية",
      "explanation": ""
    }
  ]
}

القواعد (التزم بها حرفياً):
1) الناتج JSON صالح 100%: علامات اقتباس مزدوجة فقط، بدون فواصل زائدة، بدون تعليقات، بدون أي نص خارج الكتلة.
2) title: عنوان قصير مناسب لمحتوى الاختبار. questions: مصفوفة بحد أقصى 100 سؤال.
3) لكل سؤال: الحقل text إلزامي.
   - الأسئلة الاختيارية: choices مصفوفة من 2 إلى 8 خيارات، و correctIndex رقم الخيار الصحيح ويبدأ العد من 0 (0 = الخيار الأول).
   - الأسئلة المقالية: choices تكون [] (فارغة) ويُكتب الجواب في answer.
   - explanation: شرح الحل (اختياري، يمكن تركه "").
4) الرياضيات: ضع كل رمز أو معادلة رياضية بين علامتي دولار $...$ بصيغة LaTeX، والنص العادي يبقى خارجها. الصيغ المطلوبة:
   - كسر: $\\frac{3}{4}$   (البسط ثم المقام)
   - جذر تربيعي: $\\sqrt{x}$   — جذر تكعيبي: $\\sqrt[3]{x}$   — جذر من الدرجة n: $\\sqrt[n]{x}$
   - أس: $x^{2}$ ، $2^{n+1}$   — دليل سفلي: $x_{1}$
   - ضرب وقسمة وزائد/ناقص: $\\times$ ، $\\div$ ، $\\pm$
   - مقارنة: $\\leq$ ، $\\geq$ ، $\\neq$ ، $\\approx$
   - ثوابت ورموز: $\\pi$ ، $\\infty$ ، $90^{\\circ}$ (درجة)
   - حروف يونانية: $\\alpha$ ، $\\beta$ ، $\\theta$ ، $\\Delta$ ، $\\Omega$
   - مجموع: $\\sum_{i=1}^{n} i$   — تكامل: $\\int_{0}^{1} x\\,dx$   — نهاية: $\\lim_{x\\to 0} f(x)$
   - دوال: $\\sin x$ ، $\\cos x$ ، $\\tan x$ ، $\\log_{2} x$ ، $\\ln x$
   - قيمة مطلقة: $|x|$ — متجه: $\\vec{v}$ — زاوية: $\\angle A$ — مثلث: $\\triangle ABC$
   - أسهم ومجموعات: $\\to$ ، $\\Rightarrow$ ، $\\in$ ، $\\cup$ ، $\\cap$ ، $\\subset$
   - معادلة كاملة مثال: $x = \\frac{-b \\pm \\sqrt{b^{2}-4ac}}{2a}$
   - إذا احتجت علامة الدولار كعملة اكتبها هكذا: \\$
5) مهم جداً بخصوص الشرطة المائلة: لأن الملف JSON يجب كتابة كل شرطة مائلة "\" مرتين "\\" كما في الأمثلة أعلاه. الصحيح: "$\\frac{1}{2}$" والخطأ: "$\frac{1}{2}$".
6) لا تستخدم Markdown أو HTML داخل النصوص. اكتب بلغة المادة (غالباً العربية الفصحى).
7) اجعل الخيارات متقاربة الطول، وخيار واحد فقط صحيح في كل سؤال اختياري.

المادة المطلوب تحويلها إلى اختبار:
(الصق هنا المادة أو الأسئلة أو أرفق الملف)`;

/* ------------------------------------------------------------------ */
/*  قراءة ملف JSON بشكل متسامح                                         */
/* ------------------------------------------------------------------ */

const LATEX_AFTER_ESCAPE =
  /^(?:frac|forall|times|theta|tan|tau|text|textbf|to|therefore|triangle|beta|bar|binom|bigcup|bigcap|big|bullet|neq|ne|nu|nabla|notin|not|neg|ni|right|rho|rightarrow|underline|upsilon|uparrow|upharpoonleft|rfloor|rceil|rangle|lfloor|lceil|langle|rbrace|lbrace|ldots|cdot|cdots)(?![a-zA-Z])/;

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
    if (choices.length === 1) {
      warnings.push(`السؤال ${n}: فيه خيار واحد فقط فتم اعتباره سؤالاً مقالياً.`);
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

    questions.push({
      id: newQuestionId(),
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
    out.push({
      id: q.id,
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
