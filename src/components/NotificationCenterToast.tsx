import React from 'react';
import { BookOpen, MessageCircle, UserPlus, X } from 'lucide-react';
import type { InAppNotificationToast } from '../types';

interface Props {
  toasts: InAppNotificationToast[];
  onOpenToast: (toast: InAppNotificationToast) => void;
  onDismissToast: (id: string) => void;
}

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '؟';
  if (parts.length === 1) return parts[0].slice(0, 2);
  return `${parts[0][0] || ''}${parts[1][0] || ''}`;
}

export const NotificationCenterToast: React.FC<Props> = ({
  toasts,
  onOpenToast,
  onDismissToast,
}) => {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-3 right-3 z-50 flex flex-col gap-2 w-[calc(100vw-1.5rem)] max-w-xs sm:max-w-sm pointer-events-none"
      dir="rtl"
      aria-live="polite"
    >
      {toasts.slice(0, 3).map((toast) => {
        const isQuiz = toast.kind === 'quiz_share';
        const isReq = toast.kind === 'friend_request';
        const accentBg = isQuiz
          ? 'bg-[#A560E8]'
          : isReq
          ? 'bg-[#1CB0F6]'
          : 'bg-[#58CC02]';
        const borderTone = isQuiz
          ? 'border-[#A560E8]'
          : isReq
          ? 'border-[#1CB0F6]'
          : 'border-[#58CC02]';
        const badgeLabel = isQuiz
          ? 'أرسل لك اختباراً'
          : isReq
          ? 'طلب صداقة جديد'
          : 'رسالة جديدة';

        return (
          <div
            key={toast.id}
            className={`pointer-events-auto rounded-2xl bg-white border-2 border-b-4 ${borderTone} shadow-2xl p-3 flex items-start gap-2.5 transition-transform hover:scale-[1.01]`}
          >
            <button
              type="button"
              onClick={() => onOpenToast(toast)}
              className="flex items-start gap-2.5 flex-1 min-w-0 text-right cursor-pointer"
            >
              <div
                className={`w-10 h-10 rounded-full ${accentBg} text-white font-black text-xs flex items-center justify-center shrink-0 shadow-sm`}
              >
                {initialsFromName(toast.senderName)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs sm:text-sm font-black text-[#3C3C3C] truncate max-w-[160px]">
                    {toast.senderName}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-[10px] font-black text-white ${accentBg}`}
                  >
                    {isQuiz ? (
                      <BookOpen className="w-2.5 h-2.5" />
                    ) : isReq ? (
                      <UserPlus className="w-2.5 h-2.5" />
                    ) : (
                      <MessageCircle className="w-2.5 h-2.5" />
                    )}
                    <span>{badgeLabel}</span>
                  </span>
                </div>
                <p className="text-xs font-bold text-[#555555] line-clamp-2 mt-0.5 break-words">
                  {toast.body}
                </p>
                <span className="inline-block text-[10px] font-black text-[#1899D6] mt-1">
                  اضغط للانتقال مباشرة ←
                </span>
              </div>
            </button>

            <button
              type="button"
              onClick={() => onDismissToast(toast.id)}
              className="p-1 rounded-lg text-[#777777] hover:bg-[#F3F4F6] hover:text-[#3C3C3C] cursor-pointer shrink-0"
              aria-label="إغلاق الإشعار"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
