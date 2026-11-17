import React from 'react';
import { Sparkles } from 'lucide-react';
import { DuoOwlEmblem } from './DuoIcons';

export type DuoLoadingAccent = 'green' | 'blue' | 'purple' | 'gold';

interface DuoLoadingProps {
  variant?: 'fullscreen' | 'overlay' | 'card' | 'inline';
  title: string;
  subtitle?: string;
  percent?: number;
  detail?: string;
  accent?: DuoLoadingAccent;
}

const ACCENT_STYLES: Record<
  DuoLoadingAccent,
  {
    badgeBg: string;
    badgeBorder: string;
    badgeText: string;
    barBg: string;
    glow: string;
  }
> = {
  green: {
    badgeBg: 'bg-[#D7FFB8]',
    badgeBorder: 'border-[#58CC02]',
    badgeText: 'text-[#46A302]',
    barBg: 'linear-gradient(90deg, #58CC02 0%, #7BE024 50%, #58CC02 100%)',
    glow: 'shadow-[#58CC02]/20',
  },
  blue: {
    badgeBg: 'bg-[#DDF4FF]',
    badgeBorder: 'border-[#1CB0F6]',
    badgeText: 'text-[#1899D6]',
    barBg: 'linear-gradient(90deg, #1CB0F6 0%, #56C8FF 50%, #1CB0F6 100%)',
    glow: 'shadow-[#1CB0F6]/20',
  },
  purple: {
    badgeBg: 'bg-[#F3E8FF]',
    badgeBorder: 'border-[#A560E8]',
    badgeText: 'text-[#7C3AED]',
    barBg: 'linear-gradient(90deg, #A560E8 0%, #C084FC 50%, #A560E8 100%)',
    glow: 'shadow-[#A560E8]/20',
  },
  gold: {
    badgeBg: 'bg-[#FFF4CC]',
    badgeBorder: 'border-[#FFC800]',
    badgeText: 'text-[#9A6B00]',
    barBg: 'linear-gradient(90deg, #FFC800 0%, #FFD84D 50%, #FFC800 100%)',
    glow: 'shadow-[#FFC800]/20',
  },
};

export const DuoLoading: React.FC<DuoLoadingProps> = ({
  variant = 'card',
  title,
  subtitle,
  percent,
  detail,
  accent = 'green',
}) => {
  const theme = ACCENT_STYLES[accent];
  const hasPercent = typeof percent === 'number' && Number.isFinite(percent);
  const clampedPercent = hasPercent
    ? Math.max(0, Math.min(100, Math.round(percent)))
    : null;

  if (variant === 'inline') {
    return (
      <div
        role="status"
        aria-live="polite"
        className={`rounded-2xl border-2 border-[#E5E5E5] bg-white px-4 py-3 flex items-center gap-3 shadow-sm ${theme.glow}`}
      >
        <div
          className={`w-10 h-10 rounded-xl ${theme.badgeBg} border-2 ${theme.badgeBorder} flex items-center justify-center shrink-0 animate-pulse`}
        >
          <DuoOwlEmblem className="w-6 h-6" />
        </div>
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs sm:text-sm font-black text-[#3C3C3C] truncate">
              {title}
            </span>
            {clampedPercent !== null && (
              <span
                dir="ltr"
                className={`font-latin text-xs font-black px-2 py-0.5 rounded-lg border ${theme.badgeBg} ${theme.badgeBorder} ${theme.badgeText} shrink-0`}
              >
                {clampedPercent}%
              </span>
            )}
          </div>
          <div className="duo-progress-track h-2.5 w-full overflow-hidden">
            {clampedPercent !== null ? (
              <div
                className="duo-progress-fill h-full"
                style={{
                  width: `${Math.max(4, clampedPercent)}%`,
                  background: theme.barBg,
                }}
              />
            ) : (
              <div
                className="h-full w-2/5 rounded-full animate-[duoSlide_1.25s_ease-in-out_infinite]"
                style={{ background: theme.barBg }}
              />
            )}
          </div>
          {subtitle && (
            <span className="text-[11px] font-bold text-[#777777] truncate">
              {subtitle}
            </span>
          )}
        </div>
      </div>
    );
  }

  const cardBody = (
    <div
      role="status"
      aria-live="polite"
      className={`duo-card w-full max-w-md bg-white p-6 sm:p-7 flex flex-col items-center text-center gap-4 shadow-lg ${theme.glow}`}
    >
      {/* Floating Animated Mascot Badge */}
      <div className="relative">
        <div
          className={`w-20 h-20 rounded-3xl ${theme.badgeBg} border-2 border-b-4 ${theme.badgeBorder} flex items-center justify-center shadow-sm animate-bounce`}
          style={{ animationDuration: '1.6s' }}
        >
          <DuoOwlEmblem className="w-12 h-12" />
        </div>
        <span className="absolute -top-2 -left-2 w-7 h-7 rounded-full bg-white border-2 border-[#E5E5E5] flex items-center justify-center shadow-xs">
          <Sparkles className={`w-4 h-4 ${theme.badgeText} animate-pulse`} />
        </span>
      </div>

      {/* Title & Subtitle */}
      <div className="flex flex-col gap-1">
        <h3 className="text-base sm:text-lg font-black text-[#3C3C3C]">
          {title}
        </h3>
        {subtitle && (
          <p className="text-xs sm:text-sm font-bold text-[#777777] leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>

      {/* Duolingo 3D Segmented Progress Track */}
      <div className="w-full flex flex-col gap-2">
        <div className="duo-progress-track h-4 w-full overflow-hidden relative p-0.5">
          {clampedPercent !== null ? (
            <div
              className="duo-progress-fill h-full rounded-full relative overflow-hidden"
              style={{
                width: `${Math.max(4, clampedPercent)}%`,
                background: theme.barBg,
              }}
            >
              <span className="absolute inset-0 bg-gradient-to-b from-white/35 to-transparent pointer-events-none" />
            </div>
          ) : (
            <div
              className="h-full w-1/2 rounded-full relative overflow-hidden animate-[duoSlide_1.2s_ease-in-out_infinite]"
              style={{ background: theme.barBg }}
            >
              <span className="absolute inset-0 bg-gradient-to-b from-white/35 to-transparent pointer-events-none" />
            </div>
          )}
        </div>

        {(clampedPercent !== null || detail) && (
          <div className="flex items-center justify-between gap-2 text-xs font-black">
            <span className="text-[#777777] truncate">{detail || ''}</span>
            {clampedPercent !== null && (
              <span
                dir="ltr"
                className={`font-latin px-2.5 py-0.5 rounded-lg border ${theme.badgeBg} ${theme.badgeBorder} ${theme.badgeText} shrink-0`}
              >
                {clampedPercent}%
              </span>
            )}
          </div>
        )}
      </div>

      {/* Bouncing Duolingo Dots */}
      <div className="flex items-center justify-center gap-1.5 pt-0.5">
        <span
          className="w-2.5 h-2.5 rounded-full bg-[#58CC02] animate-bounce"
          style={{ animationDelay: '0ms' }}
        />
        <span
          className="w-2.5 h-2.5 rounded-full bg-[#1CB0F6] animate-bounce"
          style={{ animationDelay: '150ms' }}
        />
        <span
          className="w-2.5 h-2.5 rounded-full bg-[#FFC800] animate-bounce"
          style={{ animationDelay: '300ms' }}
        />
        <span
          className="w-2.5 h-2.5 rounded-full bg-[#A560E8] animate-bounce"
          style={{ animationDelay: '450ms' }}
        />
      </div>
    </div>
  );

  if (variant === 'fullscreen') {
    return (
      <div className="min-h-screen bg-[#FFFFFF] flex items-center justify-center p-4 sm:p-6">
        {cardBody}
      </div>
    );
  }

  if (variant === 'overlay') {
    return (
      <div className="fixed inset-0 z-[90] bg-black/55 backdrop-blur-xs flex items-center justify-center p-4">
        {cardBody}
      </div>
    );
  }

  return (
    <div className="w-full flex items-center justify-center py-6 sm:py-10 px-2">
      {cardBody}
    </div>
  );
};
