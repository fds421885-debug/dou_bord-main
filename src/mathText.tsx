import React, { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

/**
 * عرض النصوص الرياضية: كل ما بين $...$ (أو $$...$$ أو \( \) أو \[ \]) يُرسم
 * كجذور وكسور وأسس حقيقية، والباقي يبقى نصاً عادياً.
 */

type Seg = { kind: 'text' | 'math'; value: string; display: boolean };

const ESC = '\uE000';

export function splitMath(src: string): Seg[] {
  const safe = (src || '').replace(/\\\$/g, ESC);
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
}

export const MathText: React.FC<MathTextProps> = ({ text, className }) => {
  const parts = useMemo(
    () =>
      splitMath(text).map((s) =>
        s.kind === 'math' ? { ...s, html: toHtml(s.value, s.display) } : { ...s, html: null }
      ),
    [text]
  );

  return (
    <div dir="auto" className={className} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {parts.map((s, i) =>
        s.kind === 'text' ? (
          <span key={i}>{s.value}</span>
        ) : s.html ? (
          <span
            key={i}
            dir="ltr"
            className={s.display ? 'block my-1 text-center overflow-x-auto' : 'inline-block align-middle'}
            style={{ unicodeBidi: 'isolate' }}
            dangerouslySetInnerHTML={{ __html: s.html }}
          />
        ) : (
          <span key={i} dir="ltr" className="font-latin text-[#EA2B2B]">
            {s.value}
          </span>
        )
      )}
    </div>
  );
};
