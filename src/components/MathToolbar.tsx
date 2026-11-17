import React from 'react';

export interface MathSnippet {
  label: string;
  tex: string;
  title: string;
}

interface Group {
  name: string;
  items: MathSnippet[];
}

const G: Group[] = [
  {
    name: 'أساسية',
    items: [
      { label: 'a/b', tex: '\\frac{}{}', title: 'كسر' },
      { label: '√', tex: '\\sqrt{}', title: 'جذر تربيعي' },
      { label: '∛', tex: '\\sqrt[3]{}', title: 'جذر تكعيبي' },
      { label: 'ⁿ√', tex: '\\sqrt[n]{}', title: 'جذر من الدرجة n' },
      { label: 'xⁿ', tex: '^{}', title: 'أس' },
      { label: 'xₙ', tex: '_{}', title: 'دليل سفلي' },
      { label: '×', tex: '\\times ', title: 'ضرب' },
      { label: '÷', tex: '\\div ', title: 'قسمة' },
      { label: '±', tex: '\\pm ', title: 'زائد/ناقص' },
      { label: '|x|', tex: '|{}|', title: 'قيمة مطلقة' },
      { label: '( )', tex: '\\left( {} \\right)', title: 'أقواس كبيرة' },
      { label: '°', tex: '^{\\circ}', title: 'درجة' },
    ],
  },
  {
    name: 'مقارنة',
    items: [
      { label: '≤', tex: '\\leq ', title: 'أصغر أو يساوي' },
      { label: '≥', tex: '\\geq ', title: 'أكبر أو يساوي' },
      { label: '≠', tex: '\\neq ', title: 'لا يساوي' },
      { label: '≈', tex: '\\approx ', title: 'تقريباً' },
      { label: '≡', tex: '\\equiv ', title: 'تطابق' },
      { label: '∝', tex: '\\propto ', title: 'يتناسب' },
      { label: '<', tex: '<', title: 'أصغر' },
      { label: '>', tex: '>', title: 'أكبر' },
    ],
  },
  {
    name: 'رموز',
    items: [
      { label: 'π', tex: '\\pi ', title: 'باي' },
      { label: '∞', tex: '\\infty ', title: 'ما لا نهاية' },
      { label: 'θ', tex: '\\theta ', title: 'ثيتا' },
      { label: 'α', tex: '\\alpha ', title: 'ألفا' },
      { label: 'β', tex: '\\beta ', title: 'بيتا' },
      { label: 'γ', tex: '\\gamma ', title: 'جاما' },
      { label: 'λ', tex: '\\lambda ', title: 'لامدا' },
      { label: 'μ', tex: '\\mu ', title: 'ميو' },
      { label: 'σ', tex: '\\sigma ', title: 'سيجما' },
      { label: 'φ', tex: '\\varphi ', title: 'فاي' },
      { label: 'ω', tex: '\\omega ', title: 'أوميغا' },
      { label: 'Δ', tex: '\\Delta ', title: 'دلتا' },
      { label: 'Σ', tex: '\\Sigma ', title: 'سيجما كبيرة' },
      { label: 'Ω', tex: '\\Omega ', title: 'أوميغا كبيرة' },
    ],
  },
  {
    name: 'تحليل',
    items: [
      { label: '∑', tex: '\\sum_{i=1}^{n} ', title: 'مجموع' },
      { label: '∫', tex: '\\int_{}^{} ', title: 'تكامل' },
      { label: 'lim', tex: '\\lim_{x \\to } ', title: 'نهاية' },
      { label: 'sin', tex: '\\sin ', title: 'جيب' },
      { label: 'cos', tex: '\\cos ', title: 'جيب تمام' },
      { label: 'tan', tex: '\\tan ', title: 'ظل' },
      { label: 'log', tex: '\\log_{} ', title: 'لوغاريتم' },
      { label: 'ln', tex: '\\ln ', title: 'لوغاريتم طبيعي' },
      { label: "f′", tex: "f'(x)", title: 'مشتقة' },
      { label: 'dy/dx', tex: '\\frac{dy}{dx}', title: 'تفاضل' },
    ],
  },
  {
    name: 'هندسة ومجموعات',
    items: [
      { label: '∠', tex: '\\angle ', title: 'زاوية' },
      { label: '△', tex: '\\triangle ', title: 'مثلث' },
      { label: '⊥', tex: '\\perp ', title: 'عمودي' },
      { label: '∥', tex: '\\parallel ', title: 'موازي' },
      { label: 'v⃗', tex: '\\vec{}', title: 'متجه' },
      { label: 'AB̅', tex: '\\overline{}', title: 'خط فوق' },
      { label: '→', tex: '\\to ', title: 'سهم' },
      { label: '⇒', tex: '\\Rightarrow ', title: 'يقتضي' },
      { label: '⇔', tex: '\\Leftrightarrow ', title: 'إذا وفقط إذا' },
      { label: '∈', tex: '\\in ', title: 'ينتمي' },
      { label: '∉', tex: '\\notin ', title: 'لا ينتمي' },
      { label: '∪', tex: '\\cup ', title: 'اتحاد' },
      { label: '∩', tex: '\\cap ', title: 'تقاطع' },
      { label: '⊂', tex: '\\subset ', title: 'جزء من' },
      { label: '∅', tex: '\\emptyset ', title: 'المجموعة الخالية' },
      { label: 'ℝ', tex: '\\mathbb{R}', title: 'الأعداد الحقيقية' },
      { label: 'ℕ', tex: '\\mathbb{N}', title: 'الأعداد الطبيعية' },
      { label: 'ℤ', tex: '\\mathbb{Z}', title: 'الأعداد الصحيحة' },
    ],
  },
];

interface Props {
  onInsert: (tex: string) => void;
  disabled?: boolean;
}

export const MathToolbar: React.FC<Props> = ({ onInsert, disabled }) => {
  const [group, setGroup] = React.useState(0);
  return (
    <div className="rounded-2xl border-2 border-[#E5E5E5] bg-[#F7F7F7] p-2 flex flex-col gap-2" dir="rtl">
      <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
        {G.map((g, i) => (
          <button
            key={g.name}
            type="button"
            onClick={() => setGroup(i)}
            className={`px-2.5 py-1 rounded-xl text-[11px] font-black whitespace-nowrap cursor-pointer border-2 ${
              i === group
                ? 'bg-[#1CB0F6] border-[#1899D6] text-white'
                : 'bg-white border-[#E5E5E5] text-[#777777]'
            }`}
          >
            {g.name}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5" dir="ltr">
        {G[group].items.map((it) => (
          <button
            key={it.title + it.tex}
            type="button"
            title={it.title}
            disabled={disabled}
            // onMouseDown يمنع فقدان التركيز عن حقل الكتابة قبل الإدراج
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onInsert(it.tex)}
            className="min-w-[2.25rem] h-9 px-2 rounded-xl bg-white border-2 border-[#E5E5E5] border-b-4 hover:border-[#1CB0F6] text-sm font-black text-[#3C3C3C] cursor-pointer disabled:opacity-50"
          >
            {it.label}
          </button>
        ))}
      </div>
      <p className="text-[10px] font-bold text-[#777777]">
        اضغط الرمز ليُضاف في الحقل الذي تكتب فيه. الرياضيات تُكتب بين علامتي $ ... $ وتظهر مرسومة في المعاينة.
      </p>
    </div>
  );
};

/** يدرج الرمز في موضع المؤشر ويلفّه بـ $...$ تلقائياً إن لم يكن داخل معادلة. */
export function applySnippet(
  value: string,
  selStart: number,
  selEnd: number,
  tex: string
): { value: string; caret: number } {
  const before = value.slice(0, selStart);
  const selected = value.slice(selStart, selEnd);
  const after = value.slice(selEnd);
  const dollarsBefore = (before.replace(/\\\$/g, '').match(/\$/g) || []).length;
  const insideMath = dollarsBefore % 2 === 1;

  let body = tex;
  let caretInBody = body.length;
  const brace = body.indexOf('{}');
  if (brace !== -1) {
    if (selected) {
      body = body.slice(0, brace + 1) + selected + body.slice(brace + 1);
      caretInBody = brace + 1 + selected.length + 1;
    } else {
      caretInBody = brace + 1;
    }
  } else if (selected) {
    body = body + selected;
    caretInBody = body.length;
  }

  if (insideMath) {
    return { value: before + body + after, caret: before.length + caretInBody };
  }
  return {
    value: before + '$' + body + '$' + after,
    caret: before.length + 1 + caretInBody,
  };
}
