import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Award,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Crown,
  Flame,
  Gauge,
  History,
  Layers,
  Lock,
  ShieldCheck,
  Sparkles,
  Target,
  Trophy,
  Zap,
} from 'lucide-react';
import {
  ACHIEVEMENTS,
  ACHIEVEMENTS_UNLOCKED_EVENT,
  CATEGORY_LABELS,
  TIER_LABELS,
  buildAchievementsSnapshot,
  computeLeaderboardRecordHolders,
  evaluateAllAchievements,
  formatDurationCompactAr,
  loadAchievementTracking,
  type AchievementCategory,
  type AchievementTier,
  type EvaluatedAchievement,
} from '../achievements';
import { collection, getDocs, query, where } from '../firestoreTracked';
import { db } from '../firebase';
import {
  loadSessionSnapshot,
  type StoredMyQuizzesSnapshot,
  type StoredQuizAttemptsSnapshot,
} from '../localDraftStore';
import { decodeExamAttemptFromFirestore, decodeMyQuizFromFirestore } from '../quizTable';
import { reconcileAttemptsWithQuizzes } from '../exam';
import { filterAttemptsForEpoch, syncUserStatsToLeaderboard } from '../social';
import type { LeaderboardUserEntry, MyQuiz, QuizAttempt, UserProfile } from '../types';

interface Props {
  profile: UserProfile;
  resetEpoch: number;
  allUsers: LeaderboardUserEntry[];
  myEntry: LeaderboardUserEntry | null;
  onOpenMyRecord?: () => void;
}

type StatusFilter = 'all' | 'unlocked' | 'locked' | 'records';

const TIER_STYLES: Record<
  AchievementTier,
  { border: string; bg: string; badgeBg: string; badgeText: string; bar: string }
> = {
  bronze: {
    border: 'border-[#D97706]/50',
    bg: 'bg-[#FFFBF5]',
    badgeBg: 'bg-[#FEF3C7]',
    badgeText: 'text-[#92400E]',
    bar: 'bg-[#D97706]',
  },
  silver: {
    border: 'border-[#94A3B8]',
    bg: 'bg-[#F8FAFC]',
    badgeBg: 'bg-[#E2E8F0]',
    badgeText: 'text-[#334155]',
    bar: 'bg-[#64748B]',
  },
  gold: {
    border: 'border-[#FFC800]',
    bg: 'bg-[#FFFDF0]',
    badgeBg: 'bg-[#FEF08A]',
    badgeText: 'text-[#854D0E]',
    bar: 'bg-[#EAB308]',
  },
  diamond: {
    border: 'border-[#1CB0F6]',
    bg: 'bg-[#F0F9FF]',
    badgeBg: 'bg-[#E0F2FE]',
    badgeText: 'text-[#0369A1]',
    bar: 'bg-[#0284C7]',
  },
  legend: {
    border: 'border-[#A560E8]',
    bg: 'bg-[#FAF5FF]',
    badgeBg: 'bg-[#F3E8FF]',
    badgeText: 'text-[#6B21A8]',
    bar: 'bg-[#9333EA]',
  },
};

function CategoryIcon({ category, className }: { category: AchievementCategory; className?: string }) {
  switch (category) {
    case 'daily':
      return <Flame className={className} />;
    case 'speed':
      return <Zap className={className} />;
    case 'volume':
      return <Layers className={className} />;
    case 'perfection':
      return <Crown className={className} />;
    case 'consistency':
      return <Clock className={className} />;
    case 'mistakes':
      return <ShieldCheck className={className} />;
    case 'mastery':
      return <Target className={className} />;
  }
}

function formatDateShortAr(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat('ar-SA', {
      month: 'short',
      day: 'numeric',
    }).format(new Date(ms));
  } catch {
    return '';
  }
}

export const LeaderboardAchievementsCarousel: React.FC<Props> = ({
  profile,
  resetEpoch,
  allUsers,
  myEntry,
  onOpenMyRecord,
}) => {
  const [attempts, setAttempts] = useState<QuizAttempt[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<'all' | AchievementCategory>('all');
  const [recentSet, setRecentSet] = useState<Set<string>>(() => {
    const t = loadAchievementTracking(profile.uid, resetEpoch);
    return new Set(t?.recentUnlockedIds || []);
  });

  const stripRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    const loadAttempts = async () => {
      const [localSnap, localQuizzesSnap] = await Promise.all([
        loadSessionSnapshot<StoredQuizAttemptsSnapshot>('quiz_attempts'),
        loadSessionSnapshot<StoredMyQuizzesSnapshot>('my_quizzes'),
      ]);
      const byId = new Map<string, QuizAttempt>();
      if (localSnap && localSnap.ownerId === profile.uid && Array.isArray(localSnap.attempts)) {
        for (const a of localSnap.attempts) {
          const decoded = decodeExamAttemptFromFirestore(a);
          if (decoded?.id) byId.set(decoded.id, decoded);
        }
      }
      let localQuizzes: MyQuiz[] = [];
      if (localQuizzesSnap && localQuizzesSnap.ownerId === profile.uid && Array.isArray(localQuizzesSnap.quizzes)) {
        localQuizzes = localQuizzesSnap.quizzes
          .filter((x): x is MyQuiz => Boolean(x && typeof x === 'object'))
          .map(decodeMyQuizFromFirestore);
      }
      if (alive && byId.size > 0) {
        setAttempts(reconcileAttemptsWithQuizzes(Array.from(byId.values()), localQuizzes));
      }

      try {
        const [snap, quizzesSnap] = await Promise.all([
          getDocs(
            query(collection(db, 'users', profile.uid, 'quizAttempts'), where('ownerId', '==', profile.uid))
          ),
          getDocs(
            query(collection(db, 'users', profile.uid, 'myQuizzes'), where('ownerId', '==', profile.uid))
          ).catch(() => null),
        ]);
        snap.forEach((d) => {
          const data = d.data() as QuizAttempt;
          const a = decodeExamAttemptFromFirestore({ ...data, id: data?.id || d.id });
          if (a?.id) byId.set(a.id, a);
        });
        let userQuizzes: MyQuiz[] = localQuizzes;
        if (quizzesSnap) {
          const fetchedQuizzes: MyQuiz[] = [];
          quizzesSnap.forEach((d) => {
            const data = d.data() as MyQuiz;
            if (data && typeof data === 'object') {
              fetchedQuizzes.push(decodeMyQuizFromFirestore({ ...data, id: data.id || d.id }));
            }
          });
          userQuizzes = fetchedQuizzes;
        }
        const reconciled = reconcileAttemptsWithQuizzes(Array.from(byId.values()), userQuizzes);
        if (alive) {
          setAttempts(reconciled);
        }
        // Backfill achievements into leaderboardUsers doc if needed
        if (reconciled.length > 0 && profile.fullNameQuad.trim()) {
          void syncUserStatsToLeaderboard(profile.uid, profile.fullNameQuad, reconciled, resetEpoch).catch(
            () => undefined
          );
        }
      } catch {
        // Local cache suffices if offline
      }
    };

    void loadAttempts();

    const onUnlocked = () => {
      const t = loadAchievementTracking(profile.uid, resetEpoch);
      setRecentSet(new Set(t?.recentUnlockedIds || []));
      void loadAttempts();
    };
    window.addEventListener(ACHIEVEMENTS_UNLOCKED_EVENT, onUnlocked);
    return () => {
      alive = false;
      window.removeEventListener(ACHIEVEMENTS_UNLOCKED_EVENT, onUnlocked);
    };
  }, [profile.uid, profile.fullNameQuad, resetEpoch]);

  const scopedAttempts = useMemo(
    () => filterAttemptsForEpoch(attempts, resetEpoch),
    [attempts, resetEpoch]
  );

  const trackedTimestamps = useMemo(() => {
    const localTrack = loadAchievementTracking(profile.uid, resetEpoch);
    return {
      ...(myEntry?.statsSnapshot?.achievements?.unlockedAtById || {}),
      ...(localTrack?.unlockedAtById || {}),
    };
  }, [profile.uid, resetEpoch, myEntry?.statsSnapshot?.achievements?.unlockedAtById]);

  const evaluation = useMemo(() => {
    const res = evaluateAllAchievements(scopedAttempts, trackedTimestamps);
    const snap = buildAchievementsSnapshot(scopedAttempts, trackedTimestamps);
    return { ...res, snapshot: snap };
  }, [scopedAttempts, trackedTimestamps]);

  // If attempts haven't finished loading locally yet but Firestore entry already has unlockedIds
  const effectiveUnlockedIds = useMemo(() => {
    if (scopedAttempts.length > 0) return new Set(evaluation.unlockedIds);
    return new Set(myEntry?.statsSnapshot?.achievements?.unlockedIds || []);
  }, [scopedAttempts.length, evaluation.unlockedIds, myEntry?.statsSnapshot?.achievements?.unlockedIds]);

  const holdersByMetric = useMemo(() => computeLeaderboardRecordHolders(allUsers), [allUsers]);

  const filteredCards: EvaluatedAchievement[] = useMemo(() => {
    return evaluation.evaluated
      .map((item) => {
        if (scopedAttempts.length === 0 && effectiveUnlockedIds.has(item.def.id)) {
          return {
            ...item,
            unlocked: true,
            progressPct: 100,
            unlockedAt: trackedTimestamps[item.def.id],
          };
        }
        return item;
      })
      .filter((item) => {
        if (categoryFilter !== 'all' && item.def.category !== categoryFilter) return false;
        if (statusFilter === 'unlocked' && !item.unlocked) return false;
        if (statusFilter === 'locked' && item.unlocked) return false;
        if (statusFilter === 'records' && !item.def.recordMetricKey) return false;
        return true;
      });
  }, [
    evaluation.evaluated,
    scopedAttempts.length,
    effectiveUnlockedIds,
    trackedTimestamps,
    categoryFilter,
    statusFilter,
  ]);

  const myRecords =
    scopedAttempts.length > 0
      ? evaluation.snapshot.records
      : myEntry?.statsSnapshot?.achievements?.records;

  // In RTL: scrollBy(-offset) advances toward card #2, #3...; scrollBy(+offset) goes back toward #1.
  const scrollCards = (direction: 'next' | 'prev') => {
    const el = stripRef.current;
    if (!el) return;
    const step = Math.max(290, Math.round(el.clientWidth * 0.78));
    // Note: modern Chromium/Firefox RTL scrollLeft can be 0 -> negative. scrollBy with negative moves forward visually to the left in RTL.
    el.scrollBy({
      left: direction === 'next' ? -step : step,
      behavior: 'smooth',
    });
  };

  const jumpToCardIndex = (cardIndex0: number) => {
    const el = stripRef.current;
    if (!el) return;
    const child = el.children.item(cardIndex0) as HTMLElement | null;
    if (child) {
      child.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
    }
  };

  const unlockedCount = effectiveUnlockedIds.size;

  return (
    <section
      className="duo-card p-4 sm:p-5 bg-white border-2 border-[#E5E5E5] flex flex-col gap-4"
      aria-label="الأوسمة والأرقام القياسية"
    >
      {/* Top Row: Title, Count, Personal Records, Flip Controls */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-2xl bg-[#FFC800] border-2 border-b-4 border-[#E5A400] text-[#3C3C3C] flex items-center justify-center shrink-0">
            <Award className="w-6 h-6" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base sm:text-lg font-black text-[#3C3C3C]">
                الأوسمة والأرقام القياسية
              </h2>
              <span className="text-xs font-black text-[#46A302] font-latin tabular-nums">
                {unlockedCount} / {ACHIEVEMENTS.length} مكتسب
              </span>
            </div>
            <p className="text-xs font-bold text-[#777777] mt-0.5">
              اسحب أفقياً أو قلّب بالأسهم بين 100 إنجاز ورقم قياسي — كل إنجاز تكسره يُضاف فوراً إلى سجلك.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {onOpenMyRecord && (
            <button
              type="button"
              onClick={onOpenMyRecord}
              className="duo-btn flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#F4FFE8] border-2 border-b-4 border-[#58CC02] text-[#46A302] text-xs font-black whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Trophy className="w-3.5 h-3.5" />
              <span>سجلي الكامل</span>
            </button>
          )}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => scrollCards('prev')}
              className="w-9 h-9 rounded-xl bg-[#F7F7F7] hover:bg-[#EAEAEA] border-2 border-[#E5E5E5] text-[#3C3C3C] flex items-center justify-center cursor-pointer"
              title="البطاقات السابقة"
              aria-label="البطاقات السابقة"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => scrollCards('next')}
              className="w-9 h-9 rounded-xl bg-[#1CB0F6] hover:bg-[#38BDF8] border-2 border-b-4 border-[#1899D6] text-white flex items-center justify-center cursor-pointer"
              title="البطاقات التالية"
              aria-label="البطاقات التالية"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Personal Highlight Records Bar (Tabular Numerals) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="rounded-2xl bg-[#FFFDF2] border border-[#FDE68A] px-3 py-2">
          <span className="text-[11px] font-bold text-[#9A6B00] flex items-center gap-1">
            <Zap className="w-3.5 h-3.5" /> أسرع 100 سؤال لك
          </span>
          <p className="text-sm sm:text-base font-black text-[#3C3C3C] font-latin tabular-nums mt-0.5">
            {myRecords?.fastest100Sec ? formatDurationCompactAr(myRecords.fastest100Sec) : 'لم يُكسر بعد'}
          </p>
        </div>

        <div className="rounded-2xl bg-[#FFF7ED] border border-[#FED7AA] px-3 py-2">
          <span className="text-[11px] font-bold text-[#C2410C] flex items-center gap-1">
            <Flame className="w-3.5 h-3.5" /> أكثر يوم حللت فيه
          </span>
          <p className="text-sm sm:text-base font-black text-[#3C3C3C] font-latin tabular-nums mt-0.5">
            {myRecords?.maxQuestionsInDay ? `${myRecords.maxQuestionsInDay} سؤال` : '0 سؤال'}
          </p>
        </div>

        <div className="rounded-2xl bg-[#F0F9FF] border border-[#BAE6FD] px-3 py-2">
          <span className="text-[11px] font-bold text-[#0369A1] flex items-center gap-1">
            <Gauge className="w-3.5 h-3.5" /> أفضل سرعة (20+ س)
          </span>
          <p className="text-sm sm:text-base font-black text-[#3C3C3C] font-latin tabular-nums mt-0.5">
            {myRecords?.bestAvgSecPerQ ? `${myRecords.bestAvgSecPerQ} ث/س` : '—'}
          </p>
        </div>

        <div className="rounded-2xl bg-[#F4FFE8] border border-[#BBF7D0] px-3 py-2">
          <span className="text-[11px] font-bold text-[#15803D] flex items-center gap-1">
            <History className="w-3.5 h-3.5" /> أخطاء صححتها
          </span>
          <p className="text-sm sm:text-base font-black text-[#3C3C3C] font-latin tabular-nums mt-0.5">
            {myRecords?.correctedMistakesTotal || 0} خطأ
          </p>
        </div>
      </div>

      {/* Filters + Category + Quick 1..100 Range Jumps */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-1.5 bg-[#F7F7F7] p-1 rounded-2xl border border-[#E5E5E5]">
          {(
            [
              { id: 'all', label: `الكل (${ACHIEVEMENTS.length})` },
              { id: 'unlocked', label: `المكتسبة (${unlockedCount})` },
              { id: 'locked', label: `المتبقية (${ACHIEVEMENTS.length - unlockedCount})` },
              { id: 'records', label: 'الأرقام القياسية' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setStatusFilter(tab.id);
                if (stripRef.current) stripRef.current.scrollLeft = 0;
              }}
              className={`px-2.5 py-1.5 rounded-xl text-xs font-black whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                statusFilter === tab.id
                  ? 'bg-[#1CB0F6] text-white'
                  : 'text-[#777777] hover:text-[#3C3C3C]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={categoryFilter}
            onChange={(e) => {
              setCategoryFilter(e.target.value as 'all' | AchievementCategory);
              if (stripRef.current) stripRef.current.scrollLeft = 0;
            }}
            aria-label="تصفية الفئة"
            className="rounded-xl border-2 border-[#E5E5E5] bg-white px-2.5 py-1.5 text-xs font-black text-[#3C3C3C] outline-none focus:border-[#1CB0F6]"
          >
            <option value="all">كل الفئات (100)</option>
            {(Object.keys(CATEGORY_LABELS) as AchievementCategory[]).map((cat) => (
              <option key={cat} value={cat}>
                {CATEGORY_LABELS[cat]}
              </option>
            ))}
          </select>

          {filteredCards.length >= 25 && (
            <div className="hidden md:flex items-center gap-1">
              {[0, 25, 50, 75].map((startIdx) =>
                startIdx < filteredCards.length ? (
                  <button
                    key={startIdx}
                    type="button"
                    onClick={() => jumpToCardIndex(startIdx)}
                    className="px-2 py-1.5 rounded-lg bg-[#F7F7F7] hover:bg-[#E5F6FF] border border-[#E5E5E5] text-[11px] font-black text-[#555555] font-latin tabular-nums cursor-pointer"
                  >
                    {startIdx + 1}–{Math.min(startIdx + 25, filteredCards.length)}
                  </button>
                ) : null
              )}
            </div>
          )}
        </div>
      </div>

      {/* Horizontal Card Deck */}
      {filteredCards.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-[#E5E5E5] p-6 text-center flex flex-col items-center gap-2">
          <Sparkles className="w-7 h-7 text-[#FFC800]" />
          <p className="text-xs sm:text-sm font-black text-[#3C3C3C]">
            لا توجد أوسمة في هذا التصنيف حالياً
          </p>
        </div>
      ) : (
        <div
          ref={stripRef}
          className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-2 scroll-smooth"
        >
          {filteredCards.map((item) => {
            const tier = TIER_STYLES[item.def.tier];
            const holder = item.def.recordMetricKey
              ? holdersByMetric[item.def.recordMetricKey]
              : undefined;
            const isRecent = recentSet.has(item.def.id);

            return (
              <article
                key={item.def.id}
                className={`w-[272px] sm:w-[295px] shrink-0 snap-start rounded-2xl border-2 border-b-4 p-4 flex flex-col justify-between gap-3 transition-transform ${
                  item.unlocked
                    ? `${tier.border} ${tier.bg}`
                    : 'border-[#E5E5E5] bg-[#FAFAFA]'
                }`}
              >
                <div className="flex flex-col gap-2.5">
                  {/* Card Top Meta */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={`w-7 h-7 rounded-xl flex items-center justify-center shrink-0 ${
                          item.unlocked
                            ? `${tier.badgeBg} ${tier.badgeText}`
                            : 'bg-[#EAEAEA] text-[#777777]'
                        }`}
                      >
                        <CategoryIcon category={item.def.category} className="w-4 h-4" />
                      </span>
                      <span className="text-[11px] font-extrabold text-[#777777] truncate">
                        {CATEGORY_LABELS[item.def.category]}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {isRecent && item.unlocked && (
                        <span className="px-1.5 py-0.5 rounded bg-[#58CC02] text-white text-[10px] font-black">
                          جديد!
                        </span>
                      )}
                      <span className="text-[11px] font-black text-[#555555] font-latin tabular-nums">
                        #{String(item.def.order).padStart(2, '0')} · {TIER_LABELS[item.def.tier]}
                      </span>
                    </div>
                  </div>

                  {/* Title & Condition */}
                  <div>
                    <h3 className="text-sm font-black text-[#3C3C3C] leading-snug">
                      {item.def.title}
                    </h3>
                    <p className="text-xs font-bold text-[#666666] mt-1 leading-relaxed">
                      {item.def.description}
                    </p>
                  </div>
                </div>

                {/* Progress & Leaderboard Record Holder */}
                <div className="flex flex-col gap-2 pt-2 border-t border-black/5">
                  <div className="flex items-center justify-between gap-2 text-[11px] font-black">
                    <span className="text-[#3C3C3C] font-latin tabular-nums truncate">
                      {item.currentLabel}
                    </span>
                    <span className="text-[#777777] font-latin tabular-nums shrink-0">
                      الهدف: {item.targetLabel}
                    </span>
                  </div>

                  <div className="w-full h-2 rounded-full bg-[#E5E5E5] overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        item.unlocked ? 'bg-[#58CC02]' : tier.bar
                      }`}
                      style={{ width: `${Math.max(4, Math.min(100, item.progressPct))}%` }}
                    />
                  </div>

                  {holder && (
                    <div className="text-[11px] font-bold text-[#9A6B00] bg-[#FFF8DB] border border-[#FDE68A] rounded-xl px-2.5 py-1.5 flex items-center justify-between gap-2">
                      <span className="truncate">
                        الرقم القياسي: {holder.holderName.split(' ').slice(0, 2).join(' ')}
                      </span>
                      <span className="font-black font-latin tabular-nums shrink-0">
                        {holder.formattedValue}
                      </span>
                    </div>
                  )}

                  <div className="flex items-center justify-between text-[11px] font-black pt-0.5">
                    {item.unlocked ? (
                      <span className="inline-flex items-center gap-1 text-[#46A302]">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        <span>مضاف إلى سجلك</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[#888888]">
                        <Lock className="w-3.5 h-3.5 shrink-0" />
                        <span>قيد التحدي</span>
                      </span>
                    )}
                    <span className="text-[#777777] font-latin tabular-nums">
                      {item.unlocked && item.unlockedAt
                        ? formatDateShortAr(item.unlockedAt)
                        : `${item.progressPct}%`}
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};
