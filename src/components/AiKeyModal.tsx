import { useState } from 'react';
import { Bot, KeyRound, Loader2, CheckCircle2, X, ExternalLink } from 'lucide-react';
import {
  connectAndListModels,
  testModel,
  saveAiConfig,
  clearAiConfig,
  getAiConfig,
  type AiModelInfo,
} from '../aiClient';

interface Props {
  open: boolean;
  onClose: () => void;
  /** يُستدعى بعد نجاح الاتصال وحفظ الإعدادات */
  onReady: () => void;
}

export default function AiKeyModal({ open, onClose, onReady }: Props) {
  const existing = getAiConfig();
  const [key, setKey] = useState('');
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await connectAndListModels(key);
      setModels(list);
      setModel(list[0].id);
    } catch (e) {
      setModels([]);
      setError(e instanceof Error ? e.message : 'فشل الاتصال');
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await testModel(key, model);
      saveAiConfig(key, model);
      setKey('');
      setModels([]);
      onReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'فشل الاختبار');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-md rounded-3xl bg-white border-2 border-[#E5E5E5] border-b-4 p-5 sm:p-6 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-2xl bg-[#A560E8] text-white flex items-center justify-center">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-black text-[#5C1A99]">ربط الذكاء الاصطناعي</h3>
              <p className="text-[11px] font-extrabold text-[#8938D6]">مفتاحك يُحفظ في جهازك فقط</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-[#777777] cursor-pointer" aria-label="إغلاق">
            <X className="w-5 h-5" />
          </button>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-black text-[#3C3C3C] flex items-center gap-1">
            <KeyRound className="w-3.5 h-3.5" /> مفتاح Gemini API
          </span>
          <input
            type="password"
            dir="ltr"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setModels([]);
            }}
            placeholder={existing ? '•••••• (مفتاح محفوظ — الصق مفتاحاً جديداً للتغيير)' : 'AIza...'}
            className="w-full rounded-2xl border-2 border-[#E5E5E5] focus:border-[#CE82FF] outline-none px-3 py-2.5 text-sm font-bold"
            autoComplete="off"
          />
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
            className="text-[11px] font-extrabold text-[#1CB0F6] flex items-center gap-1"
          >
            احصل على مفتاح مجاني من Google AI Studio <ExternalLink className="w-3 h-3" />
          </a>
        </label>

        {models.length > 0 && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-black text-[#3C3C3C] flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5 text-[#58CC02]" /> تم الاتصال — اختر النموذج
            </span>
            <select
              dir="ltr"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-2xl border-2 border-[#E5E5E5] focus:border-[#CE82FF] outline-none px-3 py-2.5 text-sm font-bold bg-white"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.id})
                </option>
              ))}
            </select>
          </label>
        )}

        {error && (
          <div className="p-3 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-xs font-extrabold text-[#EA2B2B]">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2">
          {models.length === 0 ? (
            <button
              type="button"
              onClick={connect}
              disabled={busy || !key.trim()}
              className="duo-btn flex-1 flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl bg-[#A560E8] hover:bg-[#B57BEE] border-2 border-[#8938D6] border-b-4 text-white text-sm font-black cursor-pointer disabled:opacity-60"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} اتصال
            </button>
          ) : (
            <button
              type="button"
              onClick={start}
              disabled={busy || !model}
              className="duo-btn flex-1 flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-[#46A302] border-b-4 text-white text-sm font-black cursor-pointer disabled:opacity-60"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} اختبار وابدأ
            </button>
          )}
          {existing && (
            <button
              type="button"
              onClick={() => {
                clearAiConfig();
                onClose();
              }}
              className="px-3 py-2.5 rounded-2xl border-2 border-[#E5E5E5] text-xs font-black text-[#EA2B2B] cursor-pointer"
            >
              حذف المفتاح
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
