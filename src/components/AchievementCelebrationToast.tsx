import React, { useEffect, useState } from 'react';
import { Award, Flame, Trophy, X } from 'lucide-react';
import {
  ACHIEVEMENTS_UNLOCKED_EVENT,
  CATEGORY_LABELS,
  type AchievementUnlockEventDetail,
} from '../achievements';
import { playDuoSound } from './DuoIcons';

interface Props {
  currentUid?: string;
  onOpenLeaderboard?: () => void;
}

export const AchievementCelebrationToast: React.FC<Props> = ({
  currentUid,
  onOpenLeaderboard,
}) => {
  const [detail, setDetail] = useState<AchievementUnlockEventDetail | null>(null);

  useEffect(() => {
    let hideTimer: number | null = null;
    const handler = (ev: Event) => {
      const custom = ev as CustomEvent<AchievementUnlockEventDetail>;
      const data = custom.detail;
      if (!data) return;
      if (currentUid && data.uid !== currentUid) return;
      if (data.newlyUnlocked.length === 0 && data.brokenRecords.length === 0) return;
      setDetail(data);
      playDuoSound('correct');
      if (hideTimer) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        setDetail(null);
      }, 9500);
    };
    window.addEventListener(ACHIEVEMENTS_UNLOCKED_EVENT, handler);
    return () => {
      window.removeEventListener(ACHIEVEMENTS_UNLOCKED_EVENT, handler);
      if (hideTimer) window.clearTimeout(hideTimer);
    };
  }, [currentUid]);

  if (!detail) return null;

  const badgeCount = detail.newlyUnlocked.length;
  const firstBadge = detail.newlyUnlocked[0];
  const brokenRecord = detail.brokenRecords[0];

  return (
    <div
      className="fixed bottom-4 right-4 z-[60] max-w-sm w-[calc(100vw-2rem)]"
      dir="rtl"
      role="status"
      aria-live="polite"
    >
      <div className="duo-card p-4 bg-[#FFFDF2] border-2 border-b-4 border-[#FFC800] shadow-2xl flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-[#FFC800] border-2 border-b-4 border-[#E5A400] text-[#3C3C3C] flex items-center justify-center shrink-0">
              {badgeCount > 0 ? <Trophy className="w-5 h-5" /> : <Flame className="w-5 h-5" />}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-black text-[#9A6B00]">
                {badgeCount > 1
                  ? `إنجاز جديد! كسرت ${badgeCount} أوسمة وأضيفت إلى سجلك`
                  : badgeCount === 1
                  ? 'كسرَت وساماً جديداً وأُضيف إلى سجلك!'
                  : 'حطمت رقماً قياسياً شخصياً جديداً!'}
              </p>
              {firstBadge && (
                <p className="text-sm font-black text-[#3C3C3C] mt-0.5 leading-snug">
                  #{firstBadge.order} {firstBadge.title}
                </p>
              )}
              {!firstBadge && brokenRecord && (
                <p className="text-sm font-black text-[#3C3C3C] mt-0.5 leading-snug">
                  {brokenRecord.label}: <span className="font-latin tabular-nums text-[#46A302]">{brokenRecord.valueFormatted}</span>
                </p>
              )}
              {firstBadge && (
                <p className="text-[11px] font-bold text-[#777777] mt-0.5">
                  {CATEGORY_LABELS[firstBadge.category]} · رصيدك الآن {detail.totalUnlockedCount} / 100
                </p>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setDetail(null)}
            className="p-1 rounded-lg text-[#777777] hover:bg-black/5 cursor-pointer shrink-0"
            aria-label="إغلاق"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {detail.newlyUnlocked.length > 1 && (
          <div className="flex flex-col gap-1 border-t border-[#FDE68A] pt-2 max-h-28 overflow-y-auto">
            {detail.newlyUnlocked.slice(1, 5).map((b) => (
              <div key={b.id} className="flex items-center gap-1.5 text-xs font-extrabold text-[#3C3C3C]">
                <Award className="w-3.5 h-3.5 text-[#E5A400] shrink-0" />
                <span className="truncate">#{b.order} {b.title}</span>
              </div>
            ))}
            {detail.newlyUnlocked.length > 5 && (
              <span className="text-[11px] font-bold text-[#9A6B00]">
                +{detail.newlyUnlocked.length - 5} أوسمة أخرى في سجلك
              </span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1 border-t border-[#FDE68A]">
          <span className="text-[11px] font-bold text-[#9A6B00]">
            محفوظ في لوحة الشرف وسجلك
          </span>
          {onOpenLeaderboard && (
            <button
              type="button"
              onClick={() => {
                setDetail(null);
                onOpenLeaderboard();
              }}
              className="duo-btn px-3 py-1.5 rounded-xl bg-[#FFC800] border-2 border-b-4 border-[#E5A400] text-[#3C3C3C] text-xs font-black whitespace-nowrap shrink-0 cursor-pointer"
            >
              عرض في لوحة الشرف
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
