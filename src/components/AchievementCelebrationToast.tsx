import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Award,
  ChevronLeft,
  ChevronRight,
  Crown,
  Flame,
  RotateCcw,
  Sparkles,
  Trophy,
  X,
} from 'lucide-react';
import {
  ACHIEVEMENTS_UNLOCKED_EVENT,
  CATEGORY_LABELS,
  type AchievementUnlockEventDetail,
  type BrokenRecordEntry,
} from '../achievements';
import { playDuoSound } from './DuoIcons';

interface Props {
  currentUid?: string;
  onOpenLeaderboard?: () => void;
}

type StagePhase = 'enter' | 'crack' | 'shatter' | 'reveal';

interface ShardDef {
  id: string;
  clipPath: string;
  targetX: number;
  targetY: number;
  targetRotate: number;
  delay: number;
}

// 6 complementary polygons that cover 100% of the plaque without gaps before shattering
const PLAQUE_SHARDS: ShardDef[] = [
  {
    id: 'tl',
    clipPath: 'polygon(0% 0%, 42% 0%, 34% 52%, 0% 46%)',
    targetX: -82,
    targetY: 195,
    targetRotate: -34,
    delay: 0,
  },
  {
    id: 'tc',
    clipPath: 'polygon(42% 0%, 72% 0%, 62% 48%, 34% 52%)',
    targetX: 8,
    targetY: 225,
    targetRotate: 19,
    delay: 0.03,
  },
  {
    id: 'tr',
    clipPath: 'polygon(72% 0%, 100% 0%, 100% 50%, 62% 48%)',
    targetX: 88,
    targetY: 205,
    targetRotate: 38,
    delay: 0.015,
  },
  {
    id: 'bl',
    clipPath: 'polygon(0% 46%, 34% 52%, 44% 100%, 0% 100%)',
    targetX: -70,
    targetY: 250,
    targetRotate: -44,
    delay: 0.04,
  },
  {
    id: 'bc',
    clipPath: 'polygon(34% 52%, 62% 48%, 74% 100%, 44% 100%)',
    targetX: -12,
    targetY: 270,
    targetRotate: -16,
    delay: 0.025,
  },
  {
    id: 'br',
    clipPath: 'polygon(62% 48%, 100% 50%, 100% 100%, 74% 100%)',
    targetX: 76,
    targetY: 245,
    targetRotate: 42,
    delay: 0.05,
  },
];

const DEBRIS_CHIPS = [
  { id: 'c1', left: '22%', top: '38%', x: -95, y: 210, rot: -130, size: 9 },
  { id: 'c2', left: '48%', top: '44%', x: 18, y: 240, rot: 95, size: 7 },
  { id: 'c3', left: '66%', top: '34%', x: 92, y: 215, rot: 145, size: 10 },
  { id: 'c4', left: '36%', top: '62%', x: -52, y: 265, rot: -90, size: 8 },
  { id: 'c5', left: '58%', top: '60%', x: 54, y: 255, rot: 115, size: 8 },
  { id: 'c6', left: '78%', top: '54%', x: 106, y: 230, rot: 165, size: 6 },
];

const CELEBRATION_SPARKS = [
  { id: 's1', x: -115, y: -62, scale: 1.1, delay: 0.02 },
  { id: 's2', x: 118, y: -58, scale: 1, delay: 0.05 },
  { id: 's3', x: -86, y: 54, scale: 0.9, delay: 0.08 },
  { id: 's4', x: 92, y: 56, scale: 1.05, delay: 0.04 },
  { id: 's5', x: 0, y: -88, scale: 1.15, delay: 0.06 },
  { id: 's6', x: -132, y: 4, scale: 0.85, delay: 0.1 },
  { id: 's7', x: 132, y: 6, scale: 0.9, delay: 0.09 },
];

const OldRecordPlaqueBody: React.FC<{
  label: string;
  previousFormatted: string;
  cracked?: boolean;
}> = ({ label, previousFormatted, cracked }) => (
  <div
    className={`w-full rounded-2xl border-2 border-b-4 px-5 py-5 text-center select-none relative ${
      cracked
        ? 'bg-[#FFF5E6] border-[#F59E0B] text-[#78350F]'
        : 'bg-[#F8FAFC] border-[#CBD5E1] text-[#334155]'
    }`}
  >
    <span className="inline-block text-[11px] font-black tracking-wide text-[#64748B] mb-1">
      الرقم القياسي السابق
    </span>
    <p className="text-xs font-extrabold text-[#475569] mb-1.5 truncate">{label}</p>
    <div className="text-3xl sm:text-4xl font-black font-latin tabular-nums text-[#1E293B] leading-tight">
      {previousFormatted}
    </div>
  </div>
);

const RecordStageAnimation: React.FC<{
  record: BrokenRecordEntry;
  replayNonce: number;
}> = ({ record, replayNonce }) => {
  const isBreakOld = !record.isFirstTime && Boolean(record.previousFormatted);
  const [phase, setPhase] = useState<StagePhase>(isBreakOld ? 'enter' : 'enter');

  useEffect(() => {
    const timers: number[] = [];

    if (isBreakOld) {
      setPhase('enter');
      timers.push(
        window.setTimeout(() => {
          setPhase('crack');
          playDuoSound('pop');
        }, 650)
      );
      timers.push(
        window.setTimeout(() => {
          setPhase('shatter');
        }, 1180)
      );
      timers.push(
        window.setTimeout(() => {
          setPhase('reveal');
          playDuoSound('finish');
        }, 1600)
      );
    } else {
      setPhase('enter');
      timers.push(
        window.setTimeout(() => {
          setPhase('reveal');
          playDuoSound('finish');
        }, 160)
      );
    }

    return () => {
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [record.key, record.newFormatted, record.previousFormatted, isBreakOld, replayNonce]);

  const showIntactOld = isBreakOld && (phase === 'enter' || phase === 'crack');
  const showShatteringShards = isBreakOld && (phase === 'shatter' || phase === 'reveal');
  const showNewCard = phase === 'reveal';
  const previousFormatted = record.previousFormatted;

  return (
    <div className="relative w-full min-h-[225px] flex items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-b from-[#FFFDF2] to-[#FFF7D6] border-2 border-[#FDE68A] px-4 py-5">
      {/* Subtle warm radial glow during reveal */}
      <AnimatePresence>
        {showNewCard && (
          <motion.div
            key={`halo-${replayNonce}-${record.key}`}
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1.15 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.65, ease: 'easeOut' }}
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <div className="w-64 h-64 rounded-full bg-radial from-[#FFC800]/35 via-[#FFC800]/10 to-transparent" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Concentric pulse ring for first-time or reveal */}
      <AnimatePresence>
        {showNewCard && (
          <motion.div
            key={`ring-${replayNonce}-${record.key}`}
            initial={{ opacity: 0.85, scale: 0.45 }}
            animate={{ opacity: 0, scale: 1.65 }}
            transition={{ duration: 0.9, ease: 'easeOut' }}
            className="pointer-events-none absolute w-44 h-44 rounded-full border-4 border-[#FFC800]"
          />
        )}
      </AnimatePresence>

      {/* Old record plaque (enter + crack phase) */}
      <AnimatePresence>
        {showIntactOld && previousFormatted && (
          <motion.div
            key={`old-intact-${replayNonce}-${record.key}`}
            initial={{ opacity: 0, scale: 0.88, y: 14 }}
            animate={
              phase === 'crack'
                ? {
                    opacity: 1,
                    scale: 1.02,
                    y: 0,
                    x: [0, -5, 6, -5, 4, -2, 0],
                  }
                : { opacity: 1, scale: 1, y: 0, x: 0 }
            }
            exit={{ opacity: 0, transition: { duration: 0.05 } }}
            transition={
              phase === 'crack'
                ? { duration: 0.42, ease: 'easeInOut' }
                : { type: 'spring', stiffness: 280, damping: 22 }
            }
            className="relative w-full max-w-[290px] z-10"
          >
            <OldRecordPlaqueBody
              label={record.label}
              previousFormatted={previousFormatted}
              cracked={phase === 'crack'}
            />

            {/* Animated SVG crack lines sweeping across the old plaque */}
            {phase === 'crack' && (
              <svg
                viewBox="0 0 300 130"
                className="pointer-events-none absolute inset-0 w-full h-full"
                fill="none"
                aria-hidden="true"
              >
                <motion.path
                  d="M126 0 L114 34 L138 62 L106 96 L128 130"
                  stroke="#D97706"
                  strokeWidth="3.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{ duration: 0.36, ease: 'easeOut' }}
                />
                <motion.path
                  d="M214 0 L198 38 L216 66 L186 98 L218 130"
                  stroke="#B45309"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{ duration: 0.34, delay: 0.06, ease: 'easeOut' }}
                />
                <motion.path
                  d="M0 60 L68 68 L138 62 L196 64 L300 66"
                  stroke="#F59E0B"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{ duration: 0.32, delay: 0.1, ease: 'easeOut' }}
                />
              </svg>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Shattered polygon shards + falling debris pieces */}
      {showShatteringShards && previousFormatted && (
        <div
          key={`shatter-layer-${replayNonce}-${record.key}`}
          className="pointer-events-none absolute inset-0 flex items-center justify-center z-10"
          aria-hidden="true"
        >
          <div className="relative w-full max-w-[290px]">
            {PLAQUE_SHARDS.map((shard) => (
              <motion.div
                key={shard.id}
                style={{ clipPath: shard.clipPath }}
                className={shard.id === 'tl' ? 'relative w-full' : 'absolute inset-0 w-full'}
                initial={{ x: 0, y: 0, rotate: 0, opacity: 1, scale: 1 }}
                animate={{
                  x: shard.targetX,
                  y: shard.targetY,
                  rotate: shard.targetRotate,
                  opacity: [1, 1, 0],
                  scale: 0.88,
                }}
                transition={{
                  duration: 0.88,
                  delay: shard.delay,
                  ease: [0.32, 0, 0.78, 0.92],
                }}
              >
                <OldRecordPlaqueBody
                  label={record.label}
                  previousFormatted={previousFormatted}
                  cracked
                />
              </motion.div>
            ))}

            {DEBRIS_CHIPS.map((chip) => (
              <motion.div
                key={chip.id}
                style={{
                  left: chip.left,
                  top: chip.top,
                  width: chip.size,
                  height: chip.size,
                }}
                className="absolute rounded-xs bg-[#F59E0B] border border-[#B45309]"
                initial={{ x: 0, y: 0, rotate: 0, opacity: 1, scale: 1 }}
                animate={{
                  x: chip.x,
                  y: chip.y,
                  rotate: chip.rot,
                  opacity: [1, 0.95, 0],
                  scale: 0.5,
                }}
                transition={{
                  duration: 0.85,
                  ease: [0.28, 0, 0.75, 0.95],
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Celebratory floating sparks */}
      {showNewCard && (
        <div
          key={`sparks-${replayNonce}-${record.key}`}
          className="pointer-events-none absolute inset-0 flex items-center justify-center z-20"
          aria-hidden="true"
        >
          {CELEBRATION_SPARKS.map((sp) => (
            <motion.div
              key={sp.id}
              initial={{ x: 0, y: 0, scale: 0, opacity: 0 }}
              animate={{
                x: sp.x,
                y: sp.y,
                scale: [0, sp.scale, 0.5],
                opacity: [0, 1, 0],
                rotate: [0, 140],
              }}
              transition={{ duration: 0.95, delay: sp.delay, ease: 'easeOut' }}
              className="absolute text-[#F59E0B]"
            >
              <Sparkles className="w-4 h-4 fill-[#FFC800]" />
            </motion.div>
          ))}
        </div>
      )}

      {/* Emerging New Record / First-Time Record Card */}
      <AnimatePresence>
        {showNewCard && (
          <motion.div
            key={`new-card-${replayNonce}-${record.key}`}
            initial={{ opacity: 0, scale: 0.52, y: 26 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{
              type: 'spring',
              stiffness: 290,
              damping: 20,
              mass: 0.85,
            }}
            className="relative z-30 w-full max-w-[305px] rounded-2xl bg-white border-2 border-b-4 border-[#58CC02] px-5 py-4 text-center shadow-lg"
          >
            <div className="inline-flex items-center gap-1.5 text-xs font-black text-[#46A302] mb-1">
              {record.isFirstTime ? (
                <>
                  <Crown className="w-4 h-4 text-[#E5A400]" />
                  <span>رقم قياسي لأول مرة!</span>
                </>
              ) : (
                <>
                  <Flame className="w-4 h-4 text-[#F97316]" />
                  <span>رقم قياسي جديد محطَّم!</span>
                </>
              )}
            </div>

            <p className="text-sm font-black text-[#3C3C3C] mb-1.5">{record.label}</p>

            <motion.div
              initial={{ scale: 0.8 }}
              animate={{ scale: [0.8, 1.09, 1] }}
              transition={{ duration: 0.42, delay: 0.08, ease: 'easeOut' }}
              className="text-3xl sm:text-4xl font-black font-latin tabular-nums text-[#46A302] leading-tight"
            >
              {record.newFormatted}
            </motion.div>

            <p className="mt-2 text-xs font-bold text-[#777777]">
              {record.isFirstTime || !record.previousFormatted ? (
                'أول علامة تُسجَّل لك في لوحة الشرف'
              ) : (
                <>
                  حطّم الرقم السابق:{' '}
                  <span className="font-latin tabular-nums line-through text-[#94A3B8]">
                    {record.previousFormatted}
                  </span>
                </>
              )}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export const AchievementCelebrationToast: React.FC<Props> = ({
  currentUid,
  onOpenLeaderboard,
}) => {
  const [detail, setDetail] = useState<AchievementUnlockEventDetail | null>(null);
  const [activeRecordIdx, setActiveRecordIdx] = useState(0);
  const [replayNonce, setReplayNonce] = useState(0);

  useEffect(() => {
    let hideTimer: number | null = null;
    const handler = (ev: Event) => {
      const custom = ev as CustomEvent<AchievementUnlockEventDetail>;
      const data = custom.detail;
      if (!data) return;
      if (currentUid && data.uid !== currentUid) return;
      if (data.newlyUnlocked.length === 0 && data.brokenRecords.length === 0) return;

      setDetail(data);
      setActiveRecordIdx(0);
      setReplayNonce((n) => n + 1);

      if (hideTimer) window.clearTimeout(hideTimer);

      if (data.brokenRecords.length === 0) {
        playDuoSound('correct');
        hideTimer = window.setTimeout(() => {
          setDetail(null);
        }, 9500);
      }
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
  const brokenRecords = detail.brokenRecords;

  // Theatrical centered celebration stage whenever one or more personal records were set or broken
  if (brokenRecords.length > 0) {
    const safeIdx = Math.min(activeRecordIdx, brokenRecords.length - 1);
    const currentRecord = brokenRecords[safeIdx];
    const hasMultiple = brokenRecords.length > 1;
    const anyBrokenOld = brokenRecords.some((r) => !r.isFirstTime);

    return (
      <div
        className="fixed inset-0 z-[70] bg-black/55 backdrop-blur-xs flex items-center justify-center p-4"
        dir="rtl"
        role="dialog"
        aria-modal="true"
        aria-label="الرقم القياسي الجديد"
        onClick={() => setDetail(null)}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.94, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          onClick={(e) => e.stopPropagation()}
          className="duo-card w-full max-w-md max-h-[90vh] overflow-y-auto bg-white border-2 border-b-4 border-[#FFC800] p-5 shadow-2xl flex flex-col gap-4"
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-10 h-10 rounded-2xl bg-[#FFC800] border-2 border-b-4 border-[#E5A400] text-[#3C3C3C] flex items-center justify-center shrink-0">
                <Trophy className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-black text-[#3C3C3C] leading-snug">
                  {anyBrokenOld ? 'تحطيم الأرقام القياسية!' : 'إنجاز أرقام قياسية جديدة!'}
                </h3>
                <p className="text-xs font-bold text-[#777777]">
                  {hasMultiple
                    ? `حققت ${brokenRecords.length} أرقام قياسية في هذا الاختبار`
                    : currentRecord.isFirstTime
                    ? 'تم تسجيل أول رقم قياسي لك في هذا التحدي'
                    : 'تقدّمت على رقمك السابق وأُضيف إلى سجلك'}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setDetail(null)}
              className="p-1.5 rounded-xl text-[#777777] hover:bg-black/5 cursor-pointer shrink-0"
              aria-label="إغلاق"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Animated Stage */}
          <RecordStageAnimation record={currentRecord} replayNonce={replayNonce} />

          {/* Multi-record Switcher & Replay */}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setReplayNonce((n) => n + 1)}
              className="inline-flex items-center gap-1.5 text-xs font-black text-[#64748B] hover:text-[#3C3C3C] px-2.5 py-1.5 rounded-xl hover:bg-[#F1F5F9] cursor-pointer whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>إعادة العرض</span>
            </button>

            {hasMultiple && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setActiveRecordIdx((i) => (i - 1 + brokenRecords.length) % brokenRecords.length);
                    setReplayNonce((n) => n + 1);
                  }}
                  className="p-1.5 rounded-xl border border-[#E5E5E5] bg-[#FAFAFA] hover:bg-[#F0F0F0] text-[#3C3C3C] cursor-pointer"
                  aria-label="الرقم السابق"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <span className="text-xs font-black font-latin tabular-nums text-[#3C3C3C] px-1.5">
                  {safeIdx + 1} / {brokenRecords.length}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setActiveRecordIdx((i) => (i + 1) % brokenRecords.length);
                    setReplayNonce((n) => n + 1);
                  }}
                  className="p-1.5 rounded-xl border border-[#E5E5E5] bg-[#FAFAFA] hover:bg-[#F0F0F0] text-[#3C3C3C] cursor-pointer"
                  aria-label="الرقم التالي"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {/* Newly Unlocked Badges (if any accompanied this exam) */}
          {badgeCount > 0 && (
            <div className="rounded-2xl bg-[#FFFDF2] border border-[#FDE68A] p-3 flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2 text-xs font-black text-[#9A6B00]">
                <span>أوسمة جديدة أُضيفت لسجلك ({badgeCount})</span>
                <span className="font-latin tabular-nums">{detail.totalUnlockedCount} / 100</span>
              </div>
              <div className="flex flex-col gap-1 max-h-24 overflow-y-auto">
                {detail.newlyUnlocked.slice(0, 4).map((b) => (
                  <div
                    key={b.id}
                    className="flex items-center gap-1.5 text-xs font-extrabold text-[#3C3C3C]"
                  >
                    <Award className="w-3.5 h-3.5 text-[#E5A400] shrink-0" />
                    <span className="truncate">
                      #{b.order} {b.title}
                    </span>
                  </div>
                ))}
                {detail.newlyUnlocked.length > 4 && (
                  <span className="text-[11px] font-bold text-[#9A6B00]">
                    +{detail.newlyUnlocked.length - 4} أوسمة أخرى
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-2 pt-1 border-t border-[#F0F0F0]">
            {onOpenLeaderboard && (
              <button
                type="button"
                onClick={() => {
                  setDetail(null);
                  onOpenLeaderboard();
                }}
                className="duo-btn px-4 py-2 rounded-xl bg-[#FFC800] border-2 border-b-4 border-[#E5A400] text-[#3C3C3C] text-xs font-black whitespace-nowrap shrink-0 cursor-pointer"
              >
                عرض في لوحة الشرف
              </button>
            )}
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="duo-btn px-4 py-2 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-xs font-black whitespace-nowrap shrink-0 cursor-pointer"
            >
              متابعة
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  // Standard compact toast when badges unlocked without a broken numeric record
  return (
    <motion.div
      initial={{ opacity: 0, y: 18, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className="fixed bottom-4 right-4 z-[60] max-w-sm w-[calc(100vw-2rem)]"
      dir="rtl"
      role="status"
      aria-live="polite"
    >
      <div className="duo-card p-4 bg-[#FFFDF2] border-2 border-b-4 border-[#FFC800] shadow-2xl flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-[#FFC800] border-2 border-b-4 border-[#E5A400] text-[#3C3C3C] flex items-center justify-center shrink-0">
              <Trophy className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-black text-[#9A6B00]">
                {badgeCount > 1
                  ? `إنجاز جديد! كسرت ${badgeCount} أوسمة وأضيفت إلى سجلك`
                  : 'كسرَت وساماً جديداً وأُضيف إلى سجلك!'}
              </p>
              {firstBadge && (
                <>
                  <p className="text-sm font-black text-[#3C3C3C] mt-0.5 leading-snug">
                    #{firstBadge.order} {firstBadge.title}
                  </p>
                  <p className="text-[11px] font-bold text-[#777777] mt-0.5">
                    {CATEGORY_LABELS[firstBadge.category]} · رصيدك الآن{' '}
                    <span className="font-latin tabular-nums">{detail.totalUnlockedCount}</span> / 100
                  </p>
                </>
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
                <span className="truncate">
                  #{b.order} {b.title}
                </span>
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
    </motion.div>
  );
};
