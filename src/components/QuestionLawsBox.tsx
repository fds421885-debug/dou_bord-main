import React from 'react';
import { BookOpen } from 'lucide-react';
import { MathText } from '../mathText';

interface QuestionLawsBoxProps {
  laws?: string[];
  compact?: boolean;
  variant?: 'exam' | 'review';
}

export const QuestionLawsBox: React.FC<QuestionLawsBoxProps> = ({
  laws,
  compact = false,
  variant = 'exam',
}) => {
  if (!Array.isArray(laws) || laws.length === 0) return null;

  const isExam = variant === 'exam';

  return (
    <div
      className={`rounded-2xl border-2 flex flex-col gap-2 ${
        isExam
          ? 'bg-[#F0FAFF] border-[#84D8FF] p-3.5'
          : 'bg-[#F7FBFF] border-[#CBE9FA] p-2.5'
      }`}
      dir="rtl"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-black text-[#1479AD]">
          <BookOpen className="w-4 h-4 shrink-0" />
          <span>{laws.length === 1 ? 'قانون المسألة' : 'قوانين المسألة'}</span>
        </div>
        {laws.length > 1 && (
          <span className="px-2 py-0.5 rounded-lg bg-white border border-[#BCE8FF] text-[10px] font-black text-[#1479AD]">
            {laws.length} قوانين
          </span>
        )}
      </div>

      <div className={`flex flex-col ${compact ? 'gap-1' : 'gap-1.5'}`}>
        {laws.map((law, idx) => (
          <div
            key={idx}
            className={`flex items-start gap-2 rounded-xl bg-white/90 border border-[#DDF3FF] ${
              compact ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-xs sm:text-sm'
            } font-bold text-[#2C3E50] leading-relaxed`}
          >
            <span className="w-5 h-5 mt-0.5 rounded-full bg-[#1CB0F6] text-white text-[10px] font-black font-latin flex items-center justify-center shrink-0">
              {idx + 1}
            </span>
            <MathText text={law} className="flex-1 min-w-0" />
          </div>
        ))}
      </div>
    </div>
  );
};
