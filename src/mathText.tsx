import React, { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

/**
 * عرض النصوص الرياضية: كل ما بين $...$ (أو $$...$$ أو \( \) أو \[ \]) يُرسم
 * كجذور وكسور وأسس حقيقية، مع تحويل التعبيرات غير المغلفة مثل \frac{}{} و \sqrt{} تلقائياً.
 */

type Seg = { kind: 'text' | 'math'; value: string; display: boolean };

const ESC = '\uE000';

function coerceMathText(src: unknown): string {
  if (typeof src === 'string') return src;
  if (typeof src === 'number' || typeof src === 'boolean') return String(src);
  return '';
}

/** يغلّف تعبيرات LaTeX الواضحة المكتوبة خارج $...$ دون كسر النص العادي أو الأقواس. */
function normalizeBareMath(src: string): string {
  const safeSrc = coerceMathText(src);
  if (!safeSrc || (!safeSrc.includes('\\') && !safeSrc.includes('^{\\circ}'))) {
    return safeSrc;
  }
  const parts = splitMath(safeSrc);
  const arg = '(?:[^{}]|\\{[^{}]*\\})+';
  const barePattern = new RegExp(
    `(\\\\frac\\{${arg}\\}\\{${arg}\\}` +
      `|\\\\sqrt(?:\\[[^\\]]+\\])?\\{${arg}\\}` +
      `|\\\\(?:overline|vec|mathbb)\\{${arg}\\}` +
      `|(?:\\d+|[A-Za-z\\u0600-\\u06FF])?\\^\\{\\\\circ\\}` +
      `|\\\\(?:times|div|pm|leq|geq|neq|approx|equiv|propto|pi|infty|theta|alpha|beta|gamma|lambda|mu|sigma|varphi|omega|Delta|Sigma|Omega|angle|triangle|perp|parallel|in|notin|cup|cap|subset|emptyset|Rightarrow|Leftrightarrow|to)(?![A-Za-z]))`,
    'g'
  );
  return parts
    .map((seg) => {
      if (seg.kind === 'math') {
        return seg.display ? `$$${seg.value}$$` : `$${seg.value}$`;
      }
      return seg.value.replace(barePattern, (m) => `$${m}$`);
    })
    .join('');
}

/** يقص النص لطول محدد دون ترك معادلة $...$ مفتوحة في المنتصف. */
export function clipMathSafe(src: unknown, maxLen = 45): string {
  const clean = coerceMathText(src).replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  let cut = clean.slice(0, maxLen);
  const unescapedDollars = cut.replace(/\\\$/g, '').match(/\$/g);
  if (unescapedDollars && unescapedDollars.length % 2 === 1) {
    const lastDollar = cut.lastIndexOf('$');
    if (lastDollar > 0) {
      cut = cut.slice(0, lastDollar).trim();
    } else {
      cut = cut.replace(/\$/g, '').trim();
    }
  }
  return cut || clean.slice(0, maxLen).replace(/\$/g, '').trim();
}

export function splitMath(src: string): Seg[] {
  const safe = coerceMathText(src).replace(/\\\$/g, ESC);
  const re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;
  const segs: Seg[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(safe)) !== null) {
    if (m.index > last) {
      segs.push({ kind: 'text', value: safe.slice(last, m.index).split(ESC).join('$'), display: false });
    }
    const display = m[1] !== undefined || m[2] !== undefined;
    const tex = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').split(ESC).join('\\$');
    segs.push({ kind: 'math', value: tex, display });
    last = m.index + m[0].length;
  }
  if (last < safe.length) {
    segs.push({ kind: 'text', value: safe.slice(last).split(ESC).join('$'), display: false });
  }
  return segs;
}

function toHtml(tex: string, display: boolean): string | null {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      output: 'html',
      strict: 'ignore',
      trust: false,
    });
  } catch {
    return null;
  }
}

interface MathTextProps {
  text: string;
  className?: string;
  inline?: boolean;
}

export const MathText: React.FC<MathTextProps> = ({ text, className, inline }) => {
  const isInline = inline ?? Boolean(className && /\binline\b/.test(className));

  const parts = useMemo(
    () =>
      splitMath(normalizeBareMath(text)).map((s) =>
        s.kind === 'math' ? { ...s, html: toHtml(s.value, s.display) } : { ...s, html: null }
      ),
    [text]
  );

  const Tag = isInline ? 'span' : 'div';

  return (
    <Tag dir="auto" className={className} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {parts.map((s, i) =>
        s.kind === 'text' ? (
          <span key={i}>{s.value}</span>
        ) : s.html ? (
          <span
            key={i}
            dir="ltr"
            className={
              s.display && !isInline
                ? 'block my-1.5 text-center overflow-x-auto'
                : 'inline-block align-middle mx-0.5'
            }
            style={{ unicodeBidi: 'isolate' }}
            dangerouslySetInnerHTML={{ __html: s.html }}
          />
        ) : (
          <span key={i} dir="ltr" className="font-latin text-[#EA2B2B]">
            {s.value}
          </span>
        )
      )}
    </Tag>
  );
};
