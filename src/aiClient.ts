import { isBackendServerDetected, resolveApiUrl } from './apiBase';
import { activeFirebaseConfig, auth } from './firebase';

export interface AiSolution {
  finalAnswer: string;
  steps: string[];
  explanation: string;
}

export interface AiModelInfo {
  id: string;
  label: string;
}

export class AiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiKeyError';
  }
}

const API = 'https://generativelanguage.googleapis.com/v1beta';
const KEY_STORAGE = 'duoboard_user_gemini_key_v1';
const MODEL_STORAGE = 'duoboard_user_gemini_model_v1';

export function getAiConfig(): { key: string; model: string } | null {
  try {
    const key = localStorage.getItem(KEY_STORAGE) || '';
    const model = localStorage.getItem(MODEL_STORAGE) || '';
    return key && model ? { key, model } : null;
  } catch {
    return null;
  }
}

export function saveAiConfig(key: string, model: string): void {
  try {
    localStorage.setItem(KEY_STORAGE, key.trim());
    localStorage.setItem(MODEL_STORAGE, model);
  } catch {
    /* التخزين غير متاح */
  }
}

export function clearAiConfig(): void {
  try {
    localStorage.removeItem(KEY_STORAGE);
    localStorage.removeItem(MODEL_STORAGE);
  } catch {
    /* ignore */
  }
}

function modelScore(name: string): number {
  const n = name.toLowerCase();
  if (/(image|tts|audio|embed|live|imagen|veo|aqa|robotics|computer-use|learnlm|gemma|vision)/.test(n)) return -1;
  const v = /gemini-(\d+(?:\.\d+)?)/.exec(n);
  const version = v ? parseFloat(v[1]) : 0;
  const tier = n.includes('lite') ? 1 : n.includes('flash') ? 3 : n.includes('pro') ? 2 : 0;
  return version * 10 + tier;
}

/** يتحقق من المفتاح ويرجع الموديلات المتاحة له (الأنسب أولاً). */
export async function connectAndListModels(rawKey: string): Promise<AiModelInfo[]> {
  const key = rawKey.trim();
  if (!key) throw new AiKeyError('الصق مفتاح Gemini أولاً.');
  let res: Response;
  try {
    res = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  } catch {
    throw new Error('تعذر الاتصال بخدمة Gemini. تحقق من الإنترنت.');
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new AiKeyError('المفتاح غير صحيح أو غير مفعّل. تأكد من نسخه كاملاً من AI Studio.');
  }
  if (!res.ok) throw new Error('تعذر جلب الموديلات، حاول مرة أخرى.');
  const data = (await res.json()) as {
    models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
  };
  const list = (data.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }))
    .filter((m) => modelScore(m.id) > 0)
    .sort((a, b) => modelScore(b.id) - modelScore(a.id));
  if (!list.length) throw new Error('لا توجد موديلات متاحة لهذا المفتاح.');
  return list;
}

/** اختبار حقيقي للموديل المختار قبل البدء. */
export async function testModel(key: string, model: string): Promise<void> {
  const res = await fetch(`${API}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key.trim() },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'قل: تم' }] }],
      generationConfig: { maxOutputTokens: 16 },
    }),
  });
  if (res.status === 429) throw new Error('المفتاح صحيح لكن الحد المجاني مستنفد مؤقتاً. جرّب موديلاً آخر أو انتظر قليلاً.');
  if (res.status === 401 || res.status === 403) throw new AiKeyError('المفتاح غير مصرّح له باستخدام هذا الموديل.');
  if (!res.ok) throw new Error('فشل اختبار الاتصال بهذا الموديل. اختر موديلاً آخر.');
}

async function shrinkImage(dataUrl: string, maxSide = 1800, quality = 0.85): Promise<string> {
  if (!dataUrl.startsWith('data:image/')) return dataUrl;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d');
      if (!ctx) return resolve(dataUrl);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

const SYSTEM_INSTRUCTION =
  'أنت مساعد ذكي ومعلّم خبير مخصص للمشرف فقط داخل فصل دراسي تفاعلي. مهمتك قراءة السؤال من الصورة أو صفحة PDF أو النص بدقة عالية، وتقديم: (1) الإجابة النهائية الصحيحة بشكل مباشر وواضح، (2) خطوات الحل مرتبة خطوة بخطوة بأسلوب بسيط وسلس ومفصل يناسب الشرح للطلاب، (3) توضيح القاعدة أو الفكرة الأساسية للحل. إذا احتوت الصفحة على عدة مسائل أو فروع، رتّب حل كل فرع بوضوح. التزم باللغة العربية الفصحى السهلة والدقة العلمية التامة.';

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    finalAnswer: { type: 'STRING', description: 'الإجابة النهائية الصحيحة بشكل واضح ومباشر.' },
    steps: { type: 'ARRAY', items: { type: 'STRING' }, description: 'خطوات الحل مرتبة خطوة بخطوة.' },
    explanation: { type: 'STRING', description: 'شرح مبسط للفكرة أو القاعدة ونصيحة للمشرف.' },
  },
  required: ['finalAnswer', 'steps', 'explanation'],
};

async function solveViaBackend(questionText: string, imageDataUrl: string): Promise<AiSolution> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('يلزم تسجيل الدخول لاستخدام المساعد الذكي.');
  }
  const idToken = await user.getIdToken(false);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 85000);
  try {
    const resp = await fetch(resolveApiUrl('/api/ai/solve-question'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        questionText,
        imageDataUrl,
        tokenProjectId: activeFirebaseConfig.projectId,
        tokenApiKey: activeFirebaseConfig.apiKey,
        tokenFirestoreDatabaseId: activeFirebaseConfig.firestoreDatabaseId || '',
      }),
    });
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error('BACKEND_UNAVAILABLE');
    }
    const data = (await resp.json()) as Partial<AiSolution> & { error?: string };
    if (!resp.ok) {
      throw new Error(data.error || `تعذر تحليل السؤال بالذكاء الاصطناعي (${resp.status}).`);
    }
    return {
      finalAnswer:
        typeof data.finalAnswer === 'string' && data.finalAnswer.trim()
          ? data.finalAnswer.trim()
          : 'راجع خطوات الحل أدناه',
      steps: Array.isArray(data.steps)
        ? data.steps.filter((s): s is string => typeof s === 'string' && !!s.trim())
        : [],
      explanation: typeof data.explanation === 'string' ? data.explanation.trim() : '',
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('استغرق المساعد الذكي وقتاً أطول من المعتاد. أعد المحاولة الآن.');
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function solveQuestionWithAi(
  questionText: string,
  imageDataUrl: string
): Promise<AiSolution> {
  const text = questionText.trim();
  const image = imageDataUrl.trim();
  if (!text && !image) {
    throw new Error('يرجى كتابة نص السؤال أو إرفاق صورة أو صفحة PDF أولاً.');
  }

  const smallImage = image ? await shrinkImage(image) : '';

  if (isBackendServerDetected()) {
    try {
      return await solveViaBackend(text, smallImage);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      // If static-host/no-backend error and a legacy local config exists, fall through; otherwise surface real server error
      const cfg = getAiConfig();
      if (msg !== 'BACKEND_UNAVAILABLE' || !cfg) {
        if (msg === 'BACKEND_UNAVAILABLE') {
          throw new AiKeyError('لم يتم ربط خادم الذكاء الاصطناعي.');
        }
        throw err;
      }
    }
  }

  const cfg = getAiConfig();
  if (!cfg) throw new AiKeyError('لم يتم ربط الذكاء الاصطناعي بعد.');

  const parts: Array<Record<string, unknown>> = [];
  if (smallImage) {
    const m = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/.exec(smallImage);
    if (!m) throw new Error('صيغة الصورة أو صفحة PDF المرفقة غير صالحة.');
    parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
  }
  parts.push({
    text: text
      ? `السؤال أو الملاحظة المرفقة من المشرف:\n${text}\n\nحلّل الصورة (إن وُجدت) مع النص أعلاه، وأعطِ الإجابة الصحيحة النهائية مع خطوات الحل بالعربية.`
      : 'حلّل هذه الصورة جيداً، واستخرج التمرين/السؤال، ثم قدّم الإجابة الصحيحة النهائية مع شرح الحل خطوة بخطوة بالعربية.',
  });

  let res: Response;
  try {
    res = await fetch(`${API}/models/${cfg.model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.2,
        },
      }),
    });
  } catch {
    throw new Error('تعذر الاتصال بخدمة Gemini. تحقق من الإنترنت.');
  }

  if (res.status === 401 || res.status === 403) {
    throw new AiKeyError('المفتاح لم يعد صالحاً. الصق مفتاحاً جديداً.');
  }
  if (res.status === 404) throw new AiKeyError('هذا الموديل لم يعد متاحاً. اختر موديلاً آخر.');
  if (res.status === 429) throw new Error('تم تجاوز حد الطلبات المؤقت. حاول بعد لحظات أو بدّل الموديل.');
  if (!res.ok) throw new Error('حدث خطأ أثناء تحليل السؤال بالذكاء الاصطناعي، حاول مرة أخرى.');

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const raw = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!raw) throw new Error('لم يُرجع الذكاء الاصطناعي نصاً، يرجى المحاولة مرة أخرى.');
  try {
    const p = JSON.parse(raw) as Partial<AiSolution>;
    return {
      finalAnswer: typeof p.finalAnswer === 'string' && p.finalAnswer.trim() ? p.finalAnswer.trim() : 'راجع خطوات الحل أدناه',
      steps: Array.isArray(p.steps) ? p.steps.filter((s): s is string => typeof s === 'string' && !!s.trim()) : [],
      explanation: typeof p.explanation === 'string' ? p.explanation.trim() : '',
    };
  } catch {
    throw new Error('تعذر قراءة رد الذكاء الاصطناعي، حاول مرة أخرى.');
  }
}
