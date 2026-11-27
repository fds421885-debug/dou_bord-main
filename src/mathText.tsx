import React, { useMemo } from 'react';
import { MathSpan, clipMathSafe, splitMath } from './mathSpan';
import { parseMarkdownTextBlocks } from './markdownTable';
import { DataTableView } from './components/DataTableView';

export { clipMathSafe, splitMath };

/**
 * عرض النصوص الرياضية والجداول المضمّنة:
 * - يدعم كل ما بين $...$ (أو $$...$$ أو \( \) أو \[ \]) كجذور وكسور وأسس حقيقية.
 * - في الوضع الكتلي (غير inline) يكتشف جداول Markdown (سواء بسطر فواصل |---| أو بدونه)
 *   ويرسمها تلقائياً كجداول معطيات منسقة (تشمل تمثيل الساق والورقة والجداول الإحصائية).
 */

interface MathTextProps {
  text: string;
  className?: string;
  inline?: boolean;
}

export const MathText: React.FC<MathTextProps> = ({ text, className, inline }) => {
  const isInline = inline ?? Boolean(className && /\binline\b/.test(className));

  const blocks = useMemo(() => {
    if (isInline || typeof text !== 'string' || !text.includes('|')) {
      return null;
    }
    const parsed = parseMarkdownTextBlocks(text);
    const hasTable = parsed.some((b) => b.kind === 'table');
    return hasTable ? parsed : null;
  }, [text, isInline]);

  if (!blocks) {
    return <MathSpan text={text} className={className} inline={inline} />;
  }

  return (
    <div dir="auto" className={`flex flex-col gap-2.5 ${className ?? ''}`}>
      {blocks.map((block, idx) =>
        block.kind === 'text' ? (
          <MathSpan key={idx} text={block.text} />
        ) : (
          <DataTableView key={idx} table={block.table} />
        )
      )}
    </div>
  );
};
