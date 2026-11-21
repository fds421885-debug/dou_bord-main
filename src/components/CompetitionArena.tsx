import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from '../firestoreTracked';
import {
  CheckCircle2,
  Clock,
  Eye,
  Flag,
  Layers,
  Loader2,
  PenTool,
  Play,
  PlusCircle,
  Shuffle,
  Sparkles,
  Timer,
  Trophy,
  UserCheck,
  Users,
  X,
  XCircle,
  ZoomIn,
} from 'lucide-react';
import {
  db,
  getTimestampMillis,
  handleFirestoreError,
  OperationType,
} from '../firebase';
import { handleRoomListenerError } from '../roomLifecycle';
import {
  availableCount,
  buildExam,
  defaultExamTitle,
  describeTiming,
  formatDuration,
  validPool,
} from '../exam';
import {
  loadSessionSnapshot,
  saveSavedTestsListSnapshot,
  type StoredSavedTestsSnapshot,
} from '../localDraftStore';
import { MathText } from '../mathText';
import { decodeQuizQuestionFromFirestore, encodeQuestionFieldsForFirestore } from '../quizTable';
import { buildRoomQuizPool, useMyQuizzes, useRoomSharedQuizzes } from '../roomQuizzes';
import type {
  Competition,
  CompetitionAttempt,
  CompetitionCompetitor,
  CompetitionQuestion,
  ExamSettings,
  ExamTiming,
  Participant,
  ParticipantSummary,
  Room,
  SavedBoardSnapshot,
  SavedQuestion,
  SavedTest,
  Stroke,
  StudentBoard,
  UserProfile,
} from '../types';
import { ChartView } from './ChartView';
import { FigureView } from './FigureView';
import {
  DuoCheckBadge,
  DuoCrossBadge,
  DuoCrownIcon,
  DuoGemIcon,
  playDuoSound,
} from './DuoIcons';
import { RoomQuizSyncBanner } from './RoomQuizBank';
import { DuoLoading } from './DuoLoading';
import {
  WhiteboardCanvas,
  WhiteboardPreview,
  ZoomablePreviewStage,
} from './WhiteboardCanvas';

interface CompetitionArenaProps {
  room: Room;
  profile: UserProfile;
  participants: Participant[];
  isSupervisor: boolean;
  onSwitchToSlides?: () => void;
}

const CHOICE_LETTERS = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح'];
const PER_Q_PRESETS = [15, 30, 45, 60, 90, 120];
const TOTAL_MIN_PRESETS = [1, 2, 3, 5, 10, 15];
const DEFAULT_COUNTDOWN_SEC = 3;
const REVEAL_DELAY_MS = 2200;

export function formatTimeSeconds(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60000) {
    return `${(safe / 1000).toFixed(1)} ث`;
  }
  const mins = Math.floor(safe / 60000);
  const secs = ((safe % 60000) / 1000).toFixed(1);
  return `${mins} د ${secs} ث`;
}

export const CompetitionArena: React.FC<CompetitionArenaProps> = ({
  room,
  profile,
  participants,
  isSupervisor,
  onSwitchToSlides,
}) => {
  const { myQuizzes, loading: myLoading } = useMyQuizzes(profile.uid);
  const { sharedQuizzes, loading: sharedLoading } = useRoomSharedQuizzes(room.id);

  const quizPool = useMemo(
    () =>
      buildRoomQuizPool({
        myQuizzes,
        sharedQuizzes,
        myUid: profile.uid,
        myName: profile.fullNameQuad,
        isSupervisor,
      }),
    [myQuizzes, sharedQuizzes, profile.uid, profile.fullNameQuad, isSupervisor]
  );

  // Subscriptions: competitions in this room
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [compsLoading, setCompsLoading] = useState(true);
  const [dismissedCompIdForNew, setDismissedCompIdForNew] = useState<string | null>(null);

  useEffect(() => {
    const path = `rooms/${room.id}/competitions`;
    const q = query(
      collection(db, 'rooms', room.id, 'competitions'),
      where('roomId', '==', room.id)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: Competition[] = [];
        snap.forEach((d) => list.push(d.data() as Competition));
        list.sort(
          (a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt)
        );
        setCompetitions(list);
        setCompsLoading(false);
      },
      (err) => {
        setCompsLoading(false);
        void handleRoomListenerError(room.id, err, OperationType.LIST, path);
      }
    );
    return () => unsub();
  }, [room.id]);

  const latestComp = competitions[0] ?? null;
  const activeComp =
    latestComp && latestComp.id !== dismissedCompIdForNew ? latestComp : null;

  // Questions inside the active competition
  const [compQuestions, setCompQuestions] = useState<CompetitionQuestion[]>([]);
  useEffect(() => {
    if (!activeComp) {
      setCompQuestions([]);
      return;
    }
    const path = `rooms/${room.id}/competitions/${activeComp.id}/questions`;
    const q = query(
      collection(db, 'rooms', room.id, 'competitions', activeComp.id, 'questions'),
      where('roomId', '==', room.id),
      where('competitionId', '==', activeComp.id)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: CompetitionQuestion[] = [];
        snap.forEach((d) => {
          const item = d.data() as CompetitionQuestion;
          list.push({
            ...item,
            question: decodeQuizQuestionFromFirestore(
              item.question as unknown as Record<string, unknown>
            ) as unknown as CompetitionQuestion['question'],
          });
        });
        list.sort((a, b) => a.orderIndex - b.orderIndex);
        setCompQuestions(list);
      },
      (err) => {
        void handleRoomListenerError(room.id, err, OperationType.LIST, path);
      }
    );
    return () => unsub();
  }, [room.id, activeComp?.id]);

  // ====================== Setup Form State ======================
  const [sourceMode, setSourceMode] = useState<'single' | 'mix'>('single');
  const [mixMode, setMixMode] = useState<'onePerQuiz' | 'total'>('total');
  const [selectedPoolIds, setSelectedPoolIds] = useState<string[]>([]);
  const [questionCount, setQuestionCount] = useState<number>(10);
  const [shuffleQuestions, setShuffleQuestions] = useState<boolean>(true);
  const [shuffleChoices, setShuffleChoices] = useState<boolean>(true);
  const [timing, setTiming] = useState<ExamTiming>('perQuestion');
  const [perQuestionSec, setPerQuestionSec] = useState<number>(45);
  const [totalMinutes, setTotalMinutes] = useState<number>(5);
  const [includeSupervisor, setIncludeSupervisor] = useState<boolean>(true);
  const [customTitle, setCustomTitle] = useState<string>('');
  const [creatingComp, setCreatingComp] = useState<boolean>(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  // Auto-select first quiz with valid questions when pool loads
  useEffect(() => {
    setSelectedPoolIds((prev) => {
      const validPrev = prev.filter((id) => quizPool.some((e) => e.poolId === id));
      if (validPrev.length > 0) return validPrev;
      const firstReady = quizPool.find((e) => validPool(e.quiz).length > 0);
      return firstReady ? [firstReady.poolId] : [];
    });
  }, [quizPool]);

  const poolMyQuizzes = useMemo(() => quizPool.map((e) => e.quiz), [quizPool]);

  const maxAvailable = useMemo(
    () =>
      availableCount(poolMyQuizzes, {
        sourceMode,
        mixMode,
        quizIds: selectedPoolIds,
      }),
    [poolMyQuizzes, sourceMode, mixMode, selectedPoolIds]
  );

  useEffect(() => {
    if (maxAvailable > 0 && questionCount > maxAvailable) {
      setQuestionCount(maxAvailable);
    } else if (maxAvailable > 0 && questionCount < 1) {
      setQuestionCount(Math.min(10, maxAvailable));
    }
  }, [maxAvailable, questionCount]);

  const togglePoolQuiz = (poolId: string) => {
    setSetupError(null);
    if (sourceMode === 'single') {
      setSelectedPoolIds([poolId]);
      return;
    }
    setSelectedPoolIds((prev) =>
      prev.includes(poolId) ? prev.filter((id) => id !== poolId) : [...prev, poolId]
    );
  };

  const handleSourceModeChange = (next: 'single' | 'mix') => {
    setSourceMode(next);
    setSetupError(null);
    if (next === 'single' && selectedPoolIds.length > 1) {
      setSelectedPoolIds([selectedPoolIds[0]]);
    } else if (next === 'mix' && selectedPoolIds.length < 2 && quizPool.length >= 2) {
      const readyIds = quizPool
        .filter((e) => validPool(e.quiz).length > 0)
        .slice(0, 3)
        .map((e) => e.poolId);
      if (readyIds.length >= 2) setSelectedPoolIds(readyIds);
    }
  };

  const buildSetupSettings = (): ExamSettings => {
    const selectedEntries = selectedPoolIds
      .map((id) => quizPool.find((e) => e.poolId === id))
      .filter((e): e is NonNullable<typeof e> => Boolean(e));
    const effectiveMax = Math.max(1, maxAvailable);
    const effectiveCount =
      sourceMode === 'mix' && mixMode === 'onePerQuiz'
        ? effectiveMax
        : Math.max(1, Math.min(questionCount, effectiveMax));

    return {
      sourceMode,
      mixMode,
      quizIds: selectedEntries.map((e) => e.poolId),
      quizTitles: selectedEntries.map((e) => e.quiz.title),
      questionCount: effectiveCount,
      shuffleQuestions,
      shuffleChoices,
      timing,
      seconds:
        timing === 'none'
          ? 0
          : timing === 'perQuestion'
          ? Math.max(5, Math.min(600, perQuestionSec))
          : Math.max(30, Math.min(7200, totalMinutes * 60)),
    };
  };

  const handleStartCompetition = async () => {
    if (!isSupervisor || creatingComp) return;
    setSetupError(null);

    if (selectedPoolIds.length === 0) {
      setSetupError('اختر اختباراً واحداً على الأقل للبدء.');
      return;
    }
    if (maxAvailable <= 0) {
      setSetupError('الاختبارات المحددة لا تحتوي على أسئلة اختيار من متعدد صالحة.');
      return;
    }

    const settings = buildSetupSettings();
    const builtQuestions = buildExam(poolMyQuizzes, settings);
    if (builtQuestions.length === 0) {
      setSetupError('تعذر تجهيز أسئلة المنافسة من الاختبارات المحددة.');
      return;
    }

    // Build competitors list (students + supervisor if enabled or if no students joined yet)
    const competitorsMap = new Map<string, CompetitionCompetitor>();
    for (const p of participants) {
      competitorsMap.set(p.uid, {
        uid: p.uid,
        name: p.fullNameQuad.slice(0, 120),
        role: 'student',
      });
    }
    if (includeSupervisor || competitorsMap.size === 0) {
      competitorsMap.set(profile.uid, {
        uid: profile.uid,
        name: profile.fullNameQuad.slice(0, 120),
        role: 'supervisor',
      });
    }
    const competitors = Array.from(competitorsMap.values());
    const competitorIds = competitors.map((c) => c.uid);
    const compId = `comp_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const title = (customTitle.trim() || defaultExamTitle(settings)).slice(0, 200);

    setCreatingComp(true);
    try {
      // IMPORTANT: Parent competition doc MUST exist before questions subcollection batch writes
      // because security rules check exists(...) & get(...).data.createdBy on parent.
      const compRef = doc(db, 'rooms', room.id, 'competitions', compId);
      await setDoc(compRef, {
        id: compId,
        roomId: room.id,
        createdBy: profile.uid,
        createdByName: profile.fullNameQuad.slice(0, 120),
        title,
        settings,
        includeSupervisor: includeSupervisor || participants.length === 0,
        competitorIds,
        competitors,
        status: 'active',
        phase: 'countdown',
        currentIndex: 0,
        totalQuestions: builtQuestions.length,
        countdownSec: DEFAULT_COUNTDOWN_SEC,
        phaseStartedAt: serverTimestamp(),
        totalElapsedMs: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const CHUNK = 15;
      for (let i = 0; i < builtQuestions.length; i += CHUNK) {
        const batch = writeBatch(db);
        const slice = builtQuestions.slice(i, i + CHUNK);
        slice.forEach((eq, offset) => {
          const idx = i + offset;
          const qDocId = `q_${idx}`;
          const qRef = doc(
            db,
            'rooms',
            room.id,
            'competitions',
            compId,
            'questions',
            qDocId
          );
          batch.set(qRef, {
            id: qDocId,
            roomId: room.id,
            competitionId: compId,
            orderIndex: idx + 1,
            question: encodeQuestionFieldsForFirestore(
              eq as unknown as Record<string, unknown>
            ),
            status: 'solving',
            winnerId: '',
            winnerName: '',
            winnerChoiceIndex: -1,
            winnerTimeMs: 0,
            wrongPlayerIds: [],
            attempts: [],
            updatedAt: serverTimestamp(),
          });
        });
        await batch.commit();
      }

      setDismissedCompIdForNew(null);
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `rooms/${room.id}/competitions/${compId}`);
      setSetupError('تعذر بدء المنافسة. حاول مرة أخرى.');
    } finally {
      setCreatingComp(false);
    }
  };

  // ====================== Live Gameplay State ======================
  const activeQuestion = useMemo(() => {
    if (!activeComp || compQuestions.length === 0) return null;
    const byId = compQuestions.find((q) => q.id === `q_${activeComp.currentIndex}`);
    if (byId) return byId;
    return compQuestions[Math.min(activeComp.currentIndex, compQuestions.length - 1)] ?? null;
  }, [activeComp, compQuestions]);

  // Live ticker for countdown & timers (grounded on local snapshot entry to avoid clock-skew bugs)
  const phaseKey = activeComp
    ? `${activeComp.id}:${activeComp.status}:${activeComp.phase}:${activeComp.currentIndex}`
    : 'none';
  const revealKey =
    activeComp && activeQuestion
      ? `${activeComp.id}:${activeComp.currentIndex}:${activeQuestion.id}:${activeQuestion.status}`
      : 'none';

  const phaseEnteredLocalMsRef = useRef<number>(Date.now());
  const questionOpenedLocalMsRef = useRef<number>(Date.now());
  const revealEnteredLocalMsRef = useRef<number>(Date.now());
  const lastSoundPhaseRef = useRef<string>('');
  const playedResolvedSoundRef = useRef<string>('');
  const frozenSolveMsRef = useRef<Record<string, number>>({});
  const advancingRef = useRef<string>('');
  const moveToCountdownRef = useRef<string>('');
  const timeoutGuardRef = useRef<string>('');

  const [tickNowMs, setTickNowMs] = useState<number>(() => Date.now());
  const [retryNonce, setRetryNonce] = useState<number>(0);

  // Answer confirmation & race feedback
  const [pendingChoiceIdx, setPendingChoiceIdx] = useState<number | null>(null);
  const [raceNotice, setRaceNotice] = useState<string | null>(null);

  useEffect(() => {
    phaseEnteredLocalMsRef.current = Date.now();
    setTickNowMs(Date.now());
    if (activeComp?.phase !== 'countdown') {
      advancingRef.current = '';
    }
    if (activeComp?.phase !== 'question') {
      moveToCountdownRef.current = '';
    }
    timeoutGuardRef.current = '';
  }, [phaseKey, activeComp?.phase]);

  useEffect(() => {
    setPendingChoiceIdx(null);
    setRaceNotice(null);
    if (activeComp?.phase === 'question' && activeQuestion?.status === 'solving') {
      questionOpenedLocalMsRef.current = Date.now();
    }
  }, [activeComp?.id, activeComp?.currentIndex, activeComp?.phase, activeQuestion?.id]);

  // Capture exact resolve time & play sound once when a question transitions from solving -> resolved
  useEffect(() => {
    if (!activeComp || !activeQuestion || activeComp.status !== 'active') return;
    if (activeQuestion.status === 'solving') return;

    setPendingChoiceIdx(null);
    revealEnteredLocalMsRef.current = Date.now();
    setTickNowMs(Date.now());

    if (frozenSolveMsRef.current[activeQuestion.id] === undefined) {
      frozenSolveMsRef.current[activeQuestion.id] =
        activeQuestion.status === 'correct' && activeQuestion.winnerTimeMs > 0
          ? activeQuestion.winnerTimeMs
          : Math.max(100, Date.now() - questionOpenedLocalMsRef.current);
    }

    if (playedResolvedSoundRef.current !== activeQuestion.id) {
      playedResolvedSoundRef.current = activeQuestion.id;
      playDuoSound(activeQuestion.status === 'correct' ? 'correct' : 'wrong');
    }
  }, [activeComp?.id, activeComp?.status, activeQuestion?.id, activeQuestion?.status, activeQuestion?.winnerTimeMs]);

  useEffect(() => {
    if (!activeComp || activeComp.status !== 'active') return;
    const id = window.setInterval(() => setTickNowMs(Date.now()), 120);
    return () => window.clearInterval(id);
  }, [activeComp?.id, activeComp?.status]);

  const phaseElapsedMs = Math.max(0, tickNowMs - phaseEnteredLocalMsRef.current);
  const questionSolvingMs =
    activeComp?.phase === 'question' && activeQuestion
      ? activeQuestion.status === 'solving'
        ? Math.max(0, tickNowMs - questionOpenedLocalMsRef.current)
        : frozenSolveMsRef.current[activeQuestion.id] ??
          (activeQuestion.status === 'correct' && activeQuestion.winnerTimeMs > 0
            ? activeQuestion.winnerTimeMs
            : 0)
      : 0;

  const countdownRemainingSec = useMemo(() => {
    if (!activeComp || activeComp.phase !== 'countdown') return 0;
    const totalMs = (activeComp.countdownSec || DEFAULT_COUNTDOWN_SEC) * 1000;
    return Math.max(0, Math.ceil((totalMs - phaseElapsedMs) / 1000));
  }, [activeComp, phaseElapsedMs]);

  // Countdown beep sound
  useEffect(() => {
    if (!activeComp || activeComp.status !== 'active') return;
    if (activeComp.phase === 'countdown' && countdownRemainingSec > 0) {
      const k = `${phaseKey}:${countdownRemainingSec}`;
      if (lastSoundPhaseRef.current !== k) {
        lastSoundPhaseRef.current = k;
        playDuoSound('pop');
      }
    }
  }, [activeComp?.status, activeComp?.phase, phaseKey, countdownRemainingSec]);

  // Transition resolved question (after green/red color reveal) -> countdown phase
  const runMoveResolvedToCountdown = useCallback(async () => {
    if (!activeComp || !activeQuestion || activeComp.status !== 'active') return;
    if (activeComp.phase !== 'question' || activeQuestion.status === 'solving') return;

    const guardKey = `${activeComp.id}:reveal:${activeComp.currentIndex}:${activeQuestion.id}`;
    if (moveToCountdownRef.current === guardKey) return;
    moveToCountdownRef.current = guardKey;

    const compRef = doc(db, 'rooms', room.id, 'competitions', activeComp.id);
    const qRef = doc(
      db,
      'rooms',
      room.id,
      'competitions',
      activeComp.id,
      'questions',
      activeQuestion.id
    );

    try {
      await runTransaction(db, async (tx) => {
        const [compSnap, qSnap] = await Promise.all([tx.get(compRef), tx.get(qRef)]);
        if (!compSnap.exists() || !qSnap.exists()) return;
        const freshComp = compSnap.data() as Competition;
        const freshQ = qSnap.data() as CompetitionQuestion;
        if (freshComp.status !== 'active' || freshComp.phase !== 'question') return;
        if (freshQ.status === 'solving') return;

        const spentMs =
          freshQ.status === 'correct' && freshQ.winnerTimeMs > 0
            ? freshQ.winnerTimeMs
            : Math.max(
                0,
                Math.round(
                  frozenSolveMsRef.current[freshQ.id] ??
                    Date.now() - questionOpenedLocalMsRef.current
                )
              );

        tx.update(compRef, {
          phase: 'countdown',
          phaseStartedAt: serverTimestamp(),
          totalElapsedMs: Math.min(172800000, freshComp.totalElapsedMs + spentMs),
          updatedAt: serverTimestamp(),
        });
      });
    } catch {
      moveToCountdownRef.current = '';
      window.setTimeout(() => setRetryNonce((n) => n + 1), 500);
    }
  }, [activeComp, activeQuestion, room.id]);

  // Auto-advance from resolved green/red color reveal -> countdown
  useEffect(() => {
    if (!activeComp || !activeQuestion || activeComp.status !== 'active') return;
    if (activeComp.phase !== 'question' || activeQuestion.status === 'solving') return;

    const canControl = isSupervisor || activeComp.createdBy === profile.uid;
    const isCompetitor = activeComp.competitorIds.includes(profile.uid);
    if (!canControl && !isCompetitor) return;

    const alreadyRevealedMs = Math.max(0, Date.now() - revealEnteredLocalMsRef.current);
    const delayMs = canControl
      ? Math.max(60, REVEAL_DELAY_MS - alreadyRevealedMs)
      : Math.max(60, REVEAL_DELAY_MS + 1100 - alreadyRevealedMs);

    const timer = window.setTimeout(() => {
      void runMoveResolvedToCountdown();
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [
    activeComp?.id,
    activeComp?.status,
    activeComp?.phase,
    activeComp?.currentIndex,
    activeComp?.createdBy,
    activeQuestion?.id,
    activeQuestion?.status,
    revealKey,
    isSupervisor,
    profile.uid,
    retryNonce,
    runMoveResolvedToCountdown,
  ]);

  // Advance from countdown -> next question OR finished
  const runAdvanceFromCountdown = useCallback(async () => {
    if (!activeComp || activeComp.status !== 'active' || activeComp.phase !== 'countdown') {
      return;
    }
    if (compQuestions.length < activeComp.totalQuestions) return;

    const qStatus = activeQuestion?.status ?? 'solving';
    const guardKey = `${activeComp.id}:cd:${activeComp.currentIndex}:${qStatus}`;
    if (advancingRef.current === guardKey) return;
    advancingRef.current = guardKey;

    const compRef = doc(db, 'rooms', room.id, 'competitions', activeComp.id);
    try {
      await runTransaction(db, async (tx) => {
        const compSnap = await tx.get(compRef);
        if (!compSnap.exists()) return;
        const freshComp = compSnap.data() as Competition;
        if (freshComp.status !== 'active' || freshComp.phase !== 'countdown') return;

        const currQRef = doc(
          db,
          'rooms',
          room.id,
          'competitions',
          freshComp.id,
          'questions',
          `q_${freshComp.currentIndex}`
        );
        const currQSnap = await tx.get(currQRef);
        const currQ = currQSnap.exists() ? (currQSnap.data() as CompetitionQuestion) : null;

        // If Q0 hasn't been opened yet, reveal Q0
        if (freshComp.currentIndex === 0 && currQ?.status === 'solving') {
          tx.update(compRef, {
            phase: 'question',
            currentIndex: 0,
            phaseStartedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          return;
        }

        // Next question or finish competition
        if (freshComp.currentIndex + 1 < freshComp.totalQuestions) {
          tx.update(compRef, {
            phase: 'question',
            currentIndex: freshComp.currentIndex + 1,
            phaseStartedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          tx.update(compRef, {
            status: 'finished',
            totalElapsedMs: freshComp.totalElapsedMs,
            updatedAt: serverTimestamp(),
          });
        }
      });
    } catch {
      advancingRef.current = '';
      window.setTimeout(() => setRetryNonce((n) => n + 1), 600);
    }
  }, [activeComp, activeQuestion?.status, compQuestions.length, room.id]);

  // Auto-trigger countdown progression (scheduled once per countdown phase, never cancelled every 120ms)
  useEffect(() => {
    if (!activeComp || activeComp.status !== 'active' || activeComp.phase !== 'countdown') {
      return;
    }
    if (compQuestions.length < activeComp.totalQuestions) return;

    const canControl = isSupervisor || activeComp.createdBy === profile.uid;
    const isCompetitor = activeComp.competitorIds.includes(profile.uid);
    if (!canControl && !isCompetitor) return;

    const countdownMs = (activeComp.countdownSec || DEFAULT_COUNTDOWN_SEC) * 1000;
    const alreadyElapsed = Math.max(0, Date.now() - phaseEnteredLocalMsRef.current);
    const delayMs = canControl
      ? Math.max(50, countdownMs - alreadyElapsed)
      : Math.max(50, countdownMs + 1200 - alreadyElapsed);

    const timer = window.setTimeout(() => {
      void runAdvanceFromCountdown();
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [
    activeComp?.id,
    activeComp?.status,
    activeComp?.phase,
    activeComp?.currentIndex,
    activeComp?.countdownSec,
    activeComp?.totalQuestions,
    activeComp?.createdBy,
    activeQuestion?.status,
    compQuestions.length,
    isSupervisor,
    profile.uid,
    retryNonce,
    runAdvanceFromCountdown,
  ]);

  // Handle per-question timer expiry or supervisor skip (marks question unanswered -> triggers green/red reveal -> advances)
  const handleForceCloseCurrentQuestion = useCallback(
    async (elapsedMsOverride?: number) => {
      if (!activeComp || !activeQuestion || activeComp.status !== 'active') return;
      if (activeComp.phase !== 'question') return;

      // If question is already resolved (during reveal), skip directly to countdown
      if (activeQuestion.status !== 'solving') {
        await runMoveResolvedToCountdown();
        return;
      }

      const guard = `close:${activeComp.id}:${activeQuestion.id}`;
      if (timeoutGuardRef.current === guard) return;
      timeoutGuardRef.current = guard;

      const spentMs = Math.max(
        0,
        Math.round(elapsedMsOverride ?? Date.now() - questionOpenedLocalMsRef.current)
      );
      frozenSolveMsRef.current[activeQuestion.id] = spentMs;

      const compRef = doc(db, 'rooms', room.id, 'competitions', activeComp.id);
      const qRef = doc(
        db,
        'rooms',
        room.id,
        'competitions',
        activeComp.id,
        'questions',
        activeQuestion.id
      );

      try {
        await runTransaction(db, async (tx) => {
          const [compSnap, qSnap] = await Promise.all([tx.get(compRef), tx.get(qRef)]);
          if (!compSnap.exists() || !qSnap.exists()) return;
          const freshComp = compSnap.data() as Competition;
          const freshQ = qSnap.data() as CompetitionQuestion;
          if (freshComp.status !== 'active' || freshComp.phase !== 'question') return;

          if (freshQ.status === 'solving') {
            tx.update(qRef, {
              status: 'unanswered',
              updatedAt: serverTimestamp(),
            });
          }
        });
      } catch {
        timeoutGuardRef.current = '';
      }
    },
    [activeComp, activeQuestion, room.id, runMoveResolvedToCountdown]
  );

  const handleFinishCompTimeout = useCallback(async () => {
    if (!activeComp || activeComp.status !== 'active') return;
    const guard = `finish:${activeComp.id}`;
    if (timeoutGuardRef.current === guard) return;
    timeoutGuardRef.current = guard;

    const compRef = doc(db, 'rooms', room.id, 'competitions', activeComp.id);
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(compRef);
        if (!snap.exists()) return;
        const fresh = snap.data() as Competition;
        if (fresh.status !== 'active') return;

        const targetTotalMs =
          fresh.settings.timing === 'total'
            ? fresh.settings.seconds * 1000
            : Math.min(172800000, fresh.totalElapsedMs + questionSolvingMs);

        tx.update(compRef, {
          status: 'finished',
          totalElapsedMs: Math.max(0, Math.round(targetTotalMs)),
          updatedAt: serverTimestamp(),
        });
      });
    } catch {
      timeoutGuardRef.current = '';
    }
  }, [activeComp, room.id, questionSolvingMs]);

  useEffect(() => {
    if (!activeComp || activeComp.status !== 'active') return;
    const canControl = isSupervisor || activeComp.createdBy === profile.uid;
    const isCompetitor = activeComp.competitorIds.includes(profile.uid);
    if (!canControl && !isCompetitor) return;

    const extraDelay = canControl ? 80 : 1200;

    if (
      activeComp.settings.timing === 'perQuestion' &&
      activeComp.phase === 'question' &&
      activeQuestion?.status === 'solving'
    ) {
      const limitMs = Math.max(1000, activeComp.settings.seconds * 1000);
      if (questionSolvingMs >= limitMs + extraDelay) {
        void handleForceCloseCurrentQuestion(limitMs);
      }
    }

    if (activeComp.settings.timing === 'total') {
      const limitMs = Math.max(1000, activeComp.settings.seconds * 1000);
      const currentLiveMs =
        activeComp.totalElapsedMs +
        (activeComp.phase === 'question' && activeQuestion?.status === 'solving'
          ? questionSolvingMs
          : 0);
      if (currentLiveMs >= limitMs + extraDelay) {
        void handleFinishCompTimeout();
      }
    }
  }, [
    activeComp,
    activeQuestion?.id,
    activeQuestion?.status,
    questionSolvingMs,
    isSupervisor,
    profile.uid,
    handleForceCloseCurrentQuestion,
    handleFinishCompTimeout,
  ]);

  // ====================== Personal Whiteboard Per Question ======================
  const [questionBoards, setQuestionBoards] = useState<StudentBoard[]>([]);
  const [myStrokes, setMyStrokes] = useState<Stroke[]>([]);
  const [inspectedBoardUid, setInspectedBoardUid] = useState<string>('');
  const lastLocalEditRef = useRef<number>(0);
  const createdBoardKeysRef = useRef<Set<string>>(new Set());
  const writeInFlightRef = useRef<boolean>(false);
  const pendingSaveRef = useRef<{ compId: string; qId: string; strokes: Stroke[] } | null>(
    null
  );

  useEffect(() => {
    if (!activeComp || !activeQuestion || activeComp.status !== 'active') {
      setQuestionBoards([]);
      setMyStrokes([]);
      return;
    }

    const compId = activeComp.id;
    const qId = activeQuestion.id;
    const path = `rooms/${room.id}/competitions/${compId}/questions/${qId}/boards`;
    const q = query(
      collection(db, 'rooms', room.id, 'competitions', compId, 'questions', qId, 'boards'),
      where('roomId', '==', room.id),
      where('questionId', '==', qId)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: StudentBoard[] = [];
        let mine: StudentBoard | null = null;
        snap.forEach((d) => {
          const b = d.data() as StudentBoard;
          list.push(b);
          if (b.studentId === profile.uid) {
            mine = b;
            createdBoardKeysRef.current.add(`${compId}:${qId}`);
          }
        });
        setQuestionBoards(list);

        if (mine) {
          const remote = (mine as StudentBoard).strokes ?? [];
          if (remote.length === 0 || Date.now() - lastLocalEditRef.current > 1200) {
            setMyStrokes(remote);
          }
        } else {
          createdBoardKeysRef.current.delete(`${compId}:${qId}`);
          if (Date.now() - lastLocalEditRef.current > 1200) {
            setMyStrokes([]);
          }
        }
      },
      (err) => {
        void handleRoomListenerError(room.id, err, OperationType.LIST, path);
      }
    );

    return () => unsub();
  }, [room.id, activeComp?.id, activeComp?.status, activeQuestion?.id, profile.uid]);

  useEffect(() => {
    lastLocalEditRef.current = 0;
    setMyStrokes([]);
  }, [activeComp?.id, activeQuestion?.id]);

  const flushBoardSaveQueue = useCallback(async () => {
    if (writeInFlightRef.current) return;
    const task = pendingSaveRef.current;
    if (!task) return;

    pendingSaveRef.current = null;
    writeInFlightRef.current = true;

    const { compId, qId, strokes } = task;
    const key = `${compId}:${qId}`;
    const boardPath = `rooms/${room.id}/competitions/${compId}/questions/${qId}/boards/${profile.uid}`;
    const boardRef = doc(
      db,
      'rooms',
      room.id,
      'competitions',
      compId,
      'questions',
      qId,
      'boards',
      profile.uid
    );

    try {
      if (createdBoardKeysRef.current.has(key)) {
        await updateDoc(boardRef, {
          strokes,
          submitted: strokes.length > 0,
          updatedAt: serverTimestamp(),
        });
      } else {
        createdBoardKeysRef.current.add(key);
        await setDoc(boardRef, {
          studentId: profile.uid,
          studentName: profile.fullNameQuad.slice(0, 120),
          roomId: room.id,
          questionId: qId,
          strokes,
          submitted: strokes.length > 0,
          verdict: 'pending',
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('NOT_FOUND') || msg.includes('No document to update')) {
        try {
          await setDoc(boardRef, {
            studentId: profile.uid,
            studentName: profile.fullNameQuad.slice(0, 120),
            roomId: room.id,
            questionId: qId,
            strokes,
            submitted: strokes.length > 0,
            verdict: 'pending',
            updatedAt: serverTimestamp(),
          });
        } catch (inner) {
          createdBoardKeysRef.current.delete(key);
          handleFirestoreError(inner, OperationType.WRITE, boardPath);
        }
      } else {
        handleFirestoreError(err, OperationType.WRITE, boardPath);
      }
    } finally {
      writeInFlightRef.current = false;
      if (pendingSaveRef.current) {
        void flushBoardSaveQueue();
      }
    }
  }, [room.id, profile.uid, profile.fullNameQuad]);

  const handleMyStrokesChange = (nextStrokes: Stroke[]) => {
    if (!activeComp || !activeQuestion || activeComp.status !== 'active') return;
    lastLocalEditRef.current = Date.now();
    setMyStrokes(nextStrokes);
    pendingSaveRef.current = {
      compId: activeComp.id,
      qId: activeQuestion.id,
      strokes: nextStrokes,
    };
    void flushBoardSaveQueue();
  };

  // ====================== Answering a Question (First-Correct Wins + Atomic Lock) ======================
  const [answering, setAnswering] = useState(false);

  const handleAnswerChoice = async (choiceIndex: number) => {
    if (!activeComp || !activeQuestion || answering) return;
    if (activeComp.status !== 'active' || activeComp.phase !== 'question') return;
    if (activeQuestion.status !== 'solving') return;
    if (!activeComp.competitorIds.includes(profile.uid)) return;
    if (activeQuestion.wrongPlayerIds.includes(profile.uid)) return;

    const spentMs = Math.max(100, Math.round(Date.now() - questionOpenedLocalMsRef.current));
    setAnswering(true);
    setRaceNotice(null);

    const compRef = doc(db, 'rooms', room.id, 'competitions', activeComp.id);
    const qRef = doc(
      db,
      'rooms',
      room.id,
      'competitions',
      activeComp.id,
      'questions',
      activeQuestion.id
    );

    try {
      type AnswerResult =
        | { outcome: 'won' }
        | { outcome: 'wrong' | 'allWrong' | 'ignored' }
        | { outcome: 'alreadySolved'; winnerName: string; winnerTimeMs: number };

      const result = await runTransaction<AnswerResult>(db, async (tx) => {
        const [compSnap, qSnap] = await Promise.all([tx.get(compRef), tx.get(qRef)]);
        if (!compSnap.exists() || !qSnap.exists()) return { outcome: 'ignored' };
        const freshComp = compSnap.data() as Competition;
        const freshQ = qSnap.data() as CompetitionQuestion;

        if (freshComp.status !== 'active' || freshComp.phase !== 'question') {
          return { outcome: 'ignored' };
        }
        if (freshQ.status !== 'solving') {
          if (freshQ.status === 'correct' && freshQ.winnerId && freshQ.winnerId !== profile.uid) {
            return {
              outcome: 'alreadySolved',
              winnerName: freshQ.winnerName,
              winnerTimeMs: freshQ.winnerTimeMs,
            };
          }
          return { outcome: 'ignored' };
        }
        if (
          !freshComp.competitorIds.includes(profile.uid) ||
          freshQ.wrongPlayerIds.includes(profile.uid)
        ) {
          return { outcome: 'ignored' };
        }

        const isCorrect = choiceIndex === freshQ.question.correctIndex;
        const attempt: CompetitionAttempt = {
          uid: profile.uid,
          name: profile.fullNameQuad.slice(0, 120),
          choiceIndex,
          isCorrect,
          timeMs: spentMs,
        };
        const nextAttempts = [...(freshQ.attempts || []), attempt];

        if (isCorrect) {
          frozenSolveMsRef.current[freshQ.id] = spentMs;
          tx.update(qRef, {
            status: 'correct',
            winnerId: profile.uid,
            winnerName: profile.fullNameQuad.slice(0, 120),
            winnerChoiceIndex: choiceIndex,
            winnerTimeMs: spentMs,
            attempts: nextAttempts,
            updatedAt: serverTimestamp(),
          });
          return { outcome: 'won' };
        }

        const nextWrong = [...(freshQ.wrongPlayerIds || []), profile.uid];
        const everyoneWrong = nextWrong.length >= freshComp.competitorIds.length;
        if (everyoneWrong) {
          frozenSolveMsRef.current[freshQ.id] = spentMs;
        }

        tx.update(qRef, {
          status: everyoneWrong ? 'unanswered' : 'solving',
          wrongPlayerIds: nextWrong,
          attempts: nextAttempts,
          updatedAt: serverTimestamp(),
        });

        return { outcome: everyoneWrong ? 'allWrong' : 'wrong' };
      });

      setPendingChoiceIdx(null);
      if (result.outcome === 'won') {
        playedResolvedSoundRef.current = activeQuestion.id;
        playDuoSound('correct');
      } else if (result.outcome === 'wrong' || result.outcome === 'allWrong') {
        if (result.outcome === 'allWrong') {
          playedResolvedSoundRef.current = activeQuestion.id;
        }
        playDuoSound('wrong');
      } else if (result.outcome === 'alreadySolved') {
        playedResolvedSoundRef.current = activeQuestion.id;
        playDuoSound('wrong');
        setRaceNotice(
          `سبقك ${result.winnerName} بالإجابة الأسرع (${formatTimeSeconds(result.winnerTimeMs)})!`
        );
      }
    } catch (err) {
      handleFirestoreError(
        err,
        OperationType.UPDATE,
        `rooms/${room.id}/competitions/${activeComp.id}/questions/${activeQuestion.id}`
      );
    } finally {
      setAnswering(false);
    }
  };

  // ====================== Live Scores Map ======================
  const liveScoreMap = useMemo(() => {
    const scores = new Map<string, { points: number; wrongs: number; timeMs: number }>();
    if (activeComp) {
      for (const c of activeComp.competitors) {
        scores.set(c.uid, { points: 0, wrongs: 0, timeMs: 0 });
      }
    }
    for (const cq of compQuestions) {
      if (cq.status === 'correct' && cq.winnerId) {
        const entry = scores.get(cq.winnerId) ?? { points: 0, wrongs: 0, timeMs: 0 };
        entry.points += 1;
        scores.set(cq.winnerId, entry);
      }
      for (const att of cq.attempts || []) {
        const entry = scores.get(att.uid) ?? { points: 0, wrongs: 0, timeMs: 0 };
        if (!att.isCorrect) entry.wrongs += 1;
        entry.timeMs += att.timeMs || 0;
        scores.set(att.uid, entry);
      }
    }
    return scores;
  }, [activeComp, compQuestions]);

  // ====================== Finished Archive & Auto-Save ======================
  const [finishedQuestions, setFinishedQuestions] = useState<SavedQuestion[]>([]);
  const [finishedSummary, setFinishedSummary] = useState<ParticipantSummary[]>([]);
  const [loadingResults, setLoadingResults] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const persistedCompIdsRef = useRef<Set<string>>(new Set());

  const [zoomedBoard, setZoomedBoard] = useState<{
    board: SavedBoardSnapshot;
    title: string;
  } | null>(null);

  useEffect(() => {
    if (!activeComp || activeComp.status !== 'finished') return;
    if (compQuestions.length === 0) return;

    const compSnapshot = activeComp;
    const qListSnapshot = compQuestions;
    let cancelled = false;

    async function assembleAndPersist() {
      setLoadingResults(true);
      try {
        const assembled: SavedQuestion[] = [];
        for (const cq of qListSnapshot) {
          const bSnap = await getDocs(
            query(
              collection(
                db,
                'rooms',
                room.id,
                'competitions',
                compSnapshot.id,
                'questions',
                cq.id,
                'boards'
              ),
              where('roomId', '==', room.id),
              where('questionId', '==', cq.id)
            )
          );
          const boardMap = new Map<string, StudentBoard>();
          bSnap.forEach((d) => {
            const b = d.data() as StudentBoard;
            boardMap.set(b.studentId, b);
          });

          const attemptsByUid = new Map<string, CompetitionAttempt>();
          for (const att of cq.attempts || []) {
            attemptsByUid.set(att.uid, att);
          }

          const boardsList: SavedBoardSnapshot[] = compSnapshot.competitors.map((c) => {
            const sb = boardMap.get(c.uid);
            const att = attemptsByUid.get(c.uid);
            const choiceIdx = att?.choiceIndex ?? -1;
            const choiceTxt =
              choiceIdx >= 0 && choiceIdx < cq.question.choices.length
                ? cq.question.choices[choiceIdx]
                : '';
            return {
              studentId: c.uid,
              studentName: c.name,
              strokes: sb?.strokes ?? [],
              submitted: Boolean(att) || (sb?.strokes?.length ?? 0) > 0,
              verdict: att ? (att.isCorrect ? 'correct' : 'wrong') : 'pending',
              chosenIndex: choiceIdx,
              chosenText: choiceTxt,
              timeMs: att?.timeMs ?? 0,
            };
          });

          // Include any extra board written by non-listed participant just in case
          boardMap.forEach((sb, uid) => {
            if (!compSnapshot.competitors.some((c) => c.uid === uid)) {
              boardsList.push({
                studentId: sb.studentId,
                studentName: sb.studentName,
                strokes: sb.strokes ?? [],
                submitted: (sb.strokes?.length ?? 0) > 0,
                verdict: 'pending',
                chosenIndex: -1,
                chosenText: '',
                timeMs: 0,
              });
            }
          });

          assembled.push({
            id: cq.id,
            ownerId: profile.uid,
            orderIndex: cq.orderIndex,
            text: cq.question.text.slice(0, 2000),
            imageData: '',
            choices: cq.question.choices,
            correctIndex: cq.question.correctIndex,
            explanation: (cq.question.explanation || '').slice(0, 2000),
            ...(cq.question.chart ? { chart: cq.question.chart } : {}),
            ...(cq.question.figure ? { figure: cq.question.figure } : {}),
            ...(cq.question.explanationChart ? { explanationChart: cq.question.explanationChart } : {}),
            ...(cq.question.explanationFigure ? { explanationFigure: cq.question.explanationFigure } : {}),
            winnerTimeMs: cq.winnerTimeMs || 0,
            status: cq.status,
            winnerName: (cq.winnerName || '').slice(0, 120),
            boards: boardsList,
            createdAt: cq.updatedAt,
          });
        }

        const pSummary: ParticipantSummary[] = compSnapshot.competitors
          .map((c) => {
            let correctCount = 0;
            let wrongCount = 0;
            let totalTimeMs = 0;
            for (const cq of qListSnapshot) {
              if (cq.status === 'correct' && cq.winnerId === c.uid) {
                correctCount++;
              }
              for (const att of cq.attempts || []) {
                if (att.uid === c.uid) {
                  if (!att.isCorrect) wrongCount++;
                  totalTimeMs += att.timeMs || 0;
                }
              }
            }
            return {
              uid: c.uid,
              fullNameQuad: c.name,
              score: correctCount,
              correctCount,
              wrongCount,
              totalTimeMs,
            };
          })
          .sort(
            (a, b) =>
              b.score - a.score ||
              (a.totalTimeMs ?? 0) - (b.totalTimeMs ?? 0) ||
              (a.wrongCount ?? 0) - (b.wrongCount ?? 0)
          );

        if (cancelled) return;
        setFinishedQuestions(assembled);
        setFinishedSummary(pSummary);

        const savedTestId = `${room.id}_${compSnapshot.id}`.slice(0, 128);
        const savedTitle = `منافسة: ${compSnapshot.title}`.slice(0, 120);

        const localSavedObj: SavedTest = {
          id: savedTestId,
          ownerId: profile.uid,
          roomCode: room.id,
          title: savedTitle,
          userRole: isSupervisor ? 'supervisor' : 'student',
          supervisorName: room.supervisorName,
          totalQuestions: assembled.length,
          participantsSummary: pSummary,
        };
        const existingSnap =
          await loadSessionSnapshot<StoredSavedTestsSnapshot>('saved_tests');
        const prevTests =
          existingSnap && existingSnap.ownerId === profile.uid
            ? existingSnap.tests.filter((t) => t.id !== savedTestId)
            : [];
        void saveSavedTestsListSnapshot(
          profile.uid,
          [localSavedObj, ...prevTests],
          { [savedTestId]: assembled }
        );

        if (!persistedCompIdsRef.current.has(compSnapshot.id)) {
          persistedCompIdsRef.current.add(compSnapshot.id);
          const savedTestRef = doc(db, 'users', profile.uid, 'savedTests', savedTestId);
          const existsSnap = await getDoc(savedTestRef);
          if (!existsSnap.exists()) {
            const CHUNK = 5;
            const firstChunk = assembled.slice(0, CHUNK);
            const firstBatch = writeBatch(db);
            firstBatch.set(savedTestRef, {
              id: savedTestId,
              ownerId: profile.uid,
              roomCode: room.id,
              title: savedTitle,
              userRole: isSupervisor ? 'supervisor' : 'student',
              supervisorName: room.supervisorName,
              totalQuestions: assembled.length,
              participantsSummary: pSummary,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });

            for (const sq of firstChunk) {
              firstBatch.set(
                doc(db, 'users', profile.uid, 'savedTests', savedTestId, 'questions', sq.id),
                {
                  id: sq.id,
                  ownerId: profile.uid,
                  orderIndex: sq.orderIndex,
                  text: sq.text,
                  imageData: sq.imageData,
                  ...(sq.choices ? { choices: sq.choices } : {}),
                  ...(typeof sq.correctIndex === 'number'
                    ? { correctIndex: sq.correctIndex }
                    : {}),
                  ...(sq.explanation ? { explanation: sq.explanation } : {}),
                  ...(sq.chart ? { chart: sq.chart } : {}),
                  ...(sq.figure ? { figure: sq.figure } : {}),
                  ...(sq.explanationChart ? { explanationChart: sq.explanationChart } : {}),
                  ...(sq.explanationFigure ? { explanationFigure: sq.explanationFigure } : {}),
                  ...(typeof sq.winnerTimeMs === 'number'
                    ? { winnerTimeMs: sq.winnerTimeMs }
                    : {}),
                  status: sq.status,
                  winnerName: sq.winnerName,
                  boards: sq.boards,
                  createdAt: serverTimestamp(),
                }
              );
            }
            await firstBatch.commit();

            for (let i = CHUNK; i < assembled.length; i += CHUNK) {
              const batch = writeBatch(db);
              for (const sq of assembled.slice(i, i + CHUNK)) {
                batch.set(
                  doc(db, 'users', profile.uid, 'savedTests', savedTestId, 'questions', sq.id),
                  {
                    id: sq.id,
                    ownerId: profile.uid,
                    orderIndex: sq.orderIndex,
                    text: sq.text,
                    imageData: sq.imageData,
                    ...(sq.choices ? { choices: sq.choices } : {}),
                    ...(typeof sq.correctIndex === 'number'
                      ? { correctIndex: sq.correctIndex }
                      : {}),
                    ...(sq.explanation ? { explanation: sq.explanation } : {}),
                    ...(sq.chart ? { chart: sq.chart } : {}),
                    ...(sq.figure ? { figure: sq.figure } : {}),
                    ...(sq.explanationChart ? { explanationChart: sq.explanationChart } : {}),
                    ...(sq.explanationFigure ? { explanationFigure: sq.explanationFigure } : {}),
                    ...(typeof sq.winnerTimeMs === 'number'
                      ? { winnerTimeMs: sq.winnerTimeMs }
                      : {}),
                    status: sq.status,
                    winnerName: sq.winnerName,
                    boards: sq.boards,
                    createdAt: serverTimestamp(),
                  }
                );
              }
              await batch.commit();
            }
          }
          if (!cancelled) setSavedNotice(true);
        } else {
          setSavedNotice(true);
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `users/${profile.uid}/savedTests`);
      } finally {
        if (!cancelled) setLoadingResults(false);
      }
    }

    void assembleAndPersist();
    return () => {
      cancelled = true;
    };
  }, [
    activeComp?.id,
    activeComp?.status,
    compQuestions.length,
    room.id,
    room.supervisorName,
    profile.uid,
    isSupervisor,
  ]);

  // ====================== Render ======================
  if (compsLoading) {
    return (
      <DuoLoading
        variant="card"
        title="جاري تحميل وضع المنافسة..."
        subtitle="يتم مزامنة الأسئلة ولوحة المتصدرين المباشرة"
        accent="purple"
      />
    );
  }

  // ------------------ 1) FINISHED RESULTS VIEW ------------------
  if (activeComp && activeComp.status === 'finished') {
    return (
      <div className="flex flex-col gap-5">
        <div className="duo-card p-5 sm:p-7 flex flex-col md:flex-row items-center justify-between gap-4 bg-gradient-to-br from-[#FFF9E6] via-white to-[#F3E8FF]/60 border-2 border-[#FFC800]">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-[#FFC800] border-2 border-b-4 border-[#E5A400] flex items-center justify-center shrink-0">
              <Trophy className="w-9 h-9 text-[#3C3C3C]" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-black text-[#8938D6]">
                نتائج المنافسة التفاعلية
              </span>
              <h2 className="text-xl sm:text-2xl font-black text-[#3C3C3C]">
                {activeComp.title}
              </h2>
              <p className="text-xs sm:text-sm font-bold text-[#777777]">
                {activeComp.totalQuestions} سؤال ·{' '}
                {describeTiming(activeComp.settings)} · الزمن الكلي للمنافسة:{' '}
                <span className="font-latin font-black text-[#1899D6]">
                  {formatTimeSeconds(activeComp.totalElapsedMs)}
                </span>
              </p>
              {savedNotice && (
                <div className="flex items-center gap-1.5 text-xs font-black text-[#46A302] mt-0.5">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>
                    تم حفظ المنافسة بالكامل (الإجابات، الأزمنة بالثواني، والصبورات) في سجل الاختبارات المحفوظة
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {isSupervisor && (
              <button
                type="button"
                onClick={() => setDismissedCompIdForNew(activeComp.id)}
                className="duo-btn flex items-center gap-2 px-5 py-3 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-sm font-black cursor-pointer"
              >
                <PlusCircle className="w-4 h-4" />
                <span>منافسة جديدة</span>
              </button>
            )}
            {isSupervisor && onSwitchToSlides && (
              <button
                type="button"
                onClick={onSwitchToSlides}
                className="duo-btn px-4 py-3 rounded-2xl bg-white border-2 border-b-4 border-[#E5E5E5] text-sm font-black text-[#3C3C3C] cursor-pointer"
              >
                العودة لـ PDF / الصور
              </button>
            )}
          </div>
        </div>

        {loadingResults ? (
          <DuoLoading
            variant="card"
            title="جاري تجميع إجابات المتنافسين وصبوراتهم وحفظها في حسابك..."
            subtitle="يتم حفظ النتائج النهائية والأزمنة بالثواني في الأرشيف"
            accent="gold"
          />
        ) : (
          <>
            {/* Leaderboard */}
            <div className="duo-card p-5 sm:p-6 flex flex-col gap-4">
              <div className="flex items-center gap-2.5 pb-3 border-b-2 border-[#F0F0F0]">
                <DuoCrownIcon className="w-6 h-6" />
                <h3 className="text-lg font-black text-[#3C3C3C]">
                  الترتيب النهائي والأزمنة
                </h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {finishedSummary.map((p, idx) => (
                  <div
                    key={p.uid}
                    className={`p-4 rounded-2xl border-2 flex items-center justify-between gap-3 ${
                      idx === 0 && p.score > 0
                        ? 'bg-[#FFF4CC]/70 border-[#FFC800]'
                        : 'bg-[#F7F7F7] border-[#E5E5E5]'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`font-latin w-9 h-9 rounded-xl flex items-center justify-center font-black text-base shrink-0 ${
                          idx === 0 && p.score > 0
                            ? 'bg-[#FFC800] text-[#3C3C3C]'
                            : 'bg-white border-2 border-[#E5E5E5] text-[#777777]'
                        }`}
                      >
                        {idx + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-black text-[#3C3C3C] truncate">
                          {p.fullNameQuad}
                        </p>
                        <p className="text-[11px] font-bold text-[#777777] flex flex-wrap gap-2">
                          <span>
                            صحيح:{' '}
                            <strong className="font-latin text-[#46A302]">
                              {p.correctCount}
                            </strong>
                          </span>
                          <span>
                            خطأ:{' '}
                            <strong className="font-latin text-[#EA2B2B]">
                              {p.wrongCount ?? 0}
                            </strong>
                          </span>
                          <span>
                            الوقت:{' '}
                            <strong className="font-latin text-[#1899D6]">
                              {formatTimeSeconds(p.totalTimeMs ?? 0)}
                            </strong>
                          </span>
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <DuoGemIcon className="w-4 h-4" />
                      <span className="font-latin text-lg font-black text-[#1899D6]">
                        {p.score}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Per-Question Archive with choices, explanation, player choices, times, and whiteboards */}
            <div className="flex flex-col gap-4">
              <h3 className="text-lg font-black text-[#3C3C3C]">
                تفاصيل الأسئلة، الاختيارات، الأزمنة والصبورات ({finishedQuestions.length})
              </h3>

              {finishedQuestions.map((q) => (
                <div key={q.id} className="duo-card p-5 flex flex-col gap-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b-2 border-[#F0F0F0]">
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      <span className="font-latin px-3 py-1 rounded-xl bg-[#A560E8] text-white text-xs sm:text-sm font-black shrink-0">
                        س{q.orderIndex}
                      </span>
                      <MathText
                        text={q.text}
                        className="text-base sm:text-lg font-black text-[#3C3C3C] flex-1"
                      />
                    </div>

                    {q.status === 'correct' && q.winnerName ? (
                      <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-[#D7FFB8] border border-[#58CC02] text-[#46A302] text-xs font-black shrink-0">
                        <DuoCheckBadge className="w-4 h-4" />
                        <span>
                          أول من حل: {q.winnerName} ({formatTimeSeconds(q.winnerTimeMs ?? 0)})
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-[#FFDFE0] border border-[#FF4B4B] text-[#EA2B2B] text-xs font-black shrink-0">
                        <DuoCrossBadge className="w-4 h-4" />
                        <span>لم يُحل</span>
                      </div>
                    )}
                  </div>

                  {q.chart && <ChartView chart={q.chart} className="max-w-lg" />}
                  {q.figure && <FigureView figure={q.figure} className="max-w-lg" />}

                  {q.choices && q.choices.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {q.choices.map((ch, idx) => {
                        const isCorrect = idx === q.correctIndex;
                        return (
                          <div
                            key={idx}
                            className={`flex items-center gap-2 p-2.5 rounded-xl border-2 text-xs sm:text-sm font-bold ${
                              isCorrect
                                ? 'bg-[#D7FFB8]/60 border-[#58CC02] text-[#46A302]'
                                : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#3C3C3C]'
                            }`}
                          >
                            <span
                              className={`w-6 h-6 rounded-lg flex items-center justify-center text-xs font-black shrink-0 ${
                                isCorrect
                                  ? 'bg-[#58CC02] text-white'
                                  : 'bg-white border border-[#E5E5E5] text-[#777777]'
                              }`}
                            >
                              {CHOICE_LETTERS[idx] ?? idx + 1}
                            </span>
                            <MathText text={ch} className="flex-1" />
                            {isCorrect && <CheckCircle2 className="w-4 h-4 shrink-0" />}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {(q.explanation || q.explanationChart || q.explanationFigure) && (
                    <div className="p-3 rounded-xl bg-[#FFFDF2] border-2 border-[#FFC800] text-xs sm:text-sm font-bold text-[#3C3C3C] flex flex-col gap-2">
                      <span className="font-black text-[#9A6B00] text-[11px]">شرح الإجابة:</span>
                      {q.explanation && <MathText text={q.explanation} />}
                      {q.explanationChart && <ChartView chart={q.explanationChart} className="max-w-lg" />}
                      {q.explanationFigure && <FigureView figure={q.explanationFigure} compact className="max-w-lg" />}
                    </div>
                  )}

                  {/* Competitors answers + whiteboards */}
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {q.boards.map((b) => (
                      <div
                        key={b.studentId}
                        className={`p-3 rounded-2xl border-2 flex flex-col gap-2 ${
                          b.verdict === 'correct'
                            ? 'border-[#58CC02] bg-[#D7FFB8]/25'
                            : b.verdict === 'wrong'
                            ? 'border-[#FF4B4B] bg-[#FFDFE0]/25'
                            : 'border-[#E5E5E5] bg-[#F7F7F7]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-black text-[#3C3C3C] truncate">
                              {b.studentName}
                            </p>
                            <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold mt-0.5">
                              <span
                                className={
                                  b.verdict === 'correct'
                                    ? 'text-[#46A302]'
                                    : b.verdict === 'wrong'
                                    ? 'text-[#EA2B2B]'
                                    : 'text-[#777777]'
                                }
                              >
                                {b.verdict === 'correct'
                                  ? 'أول إجابة صحيحة ✓'
                                  : b.verdict === 'wrong'
                                  ? 'إجابة خاطئة ✗'
                                  : 'لم يُجب'}
                              </span>
                              {(b.timeMs ?? 0) > 0 && (
                                <span className="font-latin text-[#1899D6]">
                                  ({formatTimeSeconds(b.timeMs ?? 0)})
                                </span>
                              )}
                            </div>
                            {b.chosenText && (
                              <div className="mt-1 text-xs font-extrabold text-[#3C3C3C] bg-white/80 rounded-lg px-2 py-1 border border-[#E5E5E5]">
                                <span className="text-[#777777] ml-1">اختار:</span>
                                <MathText text={b.chosenText} className="inline" />
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setZoomedBoard({
                                board: b,
                                title: `سبورة ${b.studentName} — س${q.orderIndex}`,
                              })
                            }
                            className="p-2 rounded-xl bg-white border border-[#E5E5E5] text-[#3C3C3C] hover:text-[#1899D6] cursor-pointer shrink-0"
                            title="تكبير السبورة"
                          >
                            <ZoomIn className="w-4 h-4" />
                          </button>
                        </div>

                        <WhiteboardPreview
                          strokes={b.strokes || []}
                          emptyText="لم يكتب على السبورة"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {zoomedBoard && (
          <div
            className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-3 sm:p-4"
            onClick={() => setZoomedBoard(null)}
          >
            <div
              className="bg-white rounded-3xl p-4 sm:p-5 max-w-4xl w-full flex flex-col gap-3 max-h-[94dvh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-base font-black text-[#3C3C3C] truncate">
                  {zoomedBoard.title}
                </h3>
                <button
                  type="button"
                  onClick={() => setZoomedBoard(null)}
                  className="p-2 rounded-xl bg-[#F7F7F7] hover:bg-[#FFDFE0] text-[#3C3C3C] cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <ZoomablePreviewStage strokes={zoomedBoard.board.strokes || []} />
            </div>
          </div>
        )}
      </div>
    );
  }

  // ------------------ 2) ACTIVE GAMEPLAY VIEW ------------------
  if (activeComp && activeComp.status === 'active') {
    const isCompetitor = activeComp.competitorIds.includes(profile.uid);
    const hasWrongAttempt =
      activeQuestion?.wrongPlayerIds?.includes(profile.uid) ?? false;
    const isQuestionOpen =
      activeComp.phase === 'question' && activeQuestion?.status === 'solving';
    const isQuestionResolved =
      activeComp.phase === 'question' &&
      Boolean(activeQuestion) &&
      activeQuestion?.status !== 'solving';
    const myAttempt =
      activeQuestion?.attempts?.find((a) => a.uid === profile.uid) ?? null;
    const isInitialCountdown =
      activeComp.phase === 'countdown' &&
      activeComp.currentIndex === 0 &&
      activeQuestion?.status === 'solving';

    // Timing calculations for header display
    const perQRemainingSec =
      activeComp.settings.timing === 'perQuestion' && activeComp.phase === 'question'
        ? Math.max(
            0,
            Math.ceil((activeComp.settings.seconds * 1000 - questionSolvingMs) / 1000)
          )
        : null;

    const totalRemainingSec =
      activeComp.settings.timing === 'total'
        ? Math.max(
            0,
            Math.ceil(
              (activeComp.settings.seconds * 1000 -
                (activeComp.totalElapsedMs +
                  (activeComp.phase === 'question' && activeQuestion?.status === 'solving'
                    ? questionSolvingMs
                    : 0))) /
                1000
            )
          )
        : null;

    const currentTimerText =
      perQRemainingSec !== null
        ? `${perQRemainingSec} ث`
        : totalRemainingSec !== null
        ? formatDuration(totalRemainingSec)
        : formatTimeSeconds(activeComp.phase === 'question' ? questionSolvingMs : phaseElapsedMs);

    const inspectedBoard =
      questionBoards.find((b) => b.studentId === inspectedBoardUid) ??
      questionBoards[0] ??
      null;

    return (
      <div className="flex flex-col gap-4">
        {/* Live Scoreboard + Clock Header */}
        <div className="duo-card p-3.5 sm:p-4 flex flex-col gap-3 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#FFF4CC] border-2 border-[#FFC800] text-[#9A6B00] text-xs font-black">
                <Trophy className="w-4 h-4" />
                <span>المنافسة المباشرة</span>
              </div>
              <span className="font-latin px-3 py-1 rounded-xl bg-[#F3E8FF] border border-[#CE82FF] text-[#8938D6] text-xs font-black">
                سؤال {Math.min(activeComp.currentIndex + 1, activeComp.totalQuestions)} /{' '}
                {activeComp.totalQuestions}
              </span>
              <span className="text-xs sm:text-sm font-black text-[#3C3C3C] truncate max-w-[260px]">
                {activeComp.title}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border-2 text-xs font-black ${
                  (perQRemainingSec !== null && perQRemainingSec <= 5 && isQuestionOpen) ||
                  (totalRemainingSec !== null && totalRemainingSec <= 15 && isQuestionOpen)
                    ? 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B] animate-pulse'
                    : 'bg-[#DDF4FF] border-[#1CB0F6] text-[#1899D6]'
                }`}
              >
                <Timer className="w-4 h-4" />
                <span>
                  {activeComp.settings.timing === 'perQuestion'
                    ? 'متبقي للسؤال:'
                    : activeComp.settings.timing === 'total'
                    ? 'الوقت الكلي المتبقي:'
                    : 'الزمن:'}
                </span>
                <span className="font-latin text-sm">{currentTimerText}</span>
              </div>

              {(isSupervisor || activeComp.createdBy === profile.uid) && (
                <>
                  {activeComp.phase === 'question' && (
                    <button
                      type="button"
                      onClick={() => void handleForceCloseCurrentQuestion()}
                      className="duo-btn px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] hover:border-[#FFC800] text-xs font-black text-[#3C3C3C] cursor-pointer"
                    >
                      {isQuestionResolved ? 'انتقال الآن' : 'تخطي السؤال'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleFinishCompTimeout()}
                    className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#FF4B4B] border-2 border-b-3 border-[#EA2B2B] text-white text-xs font-black cursor-pointer"
                  >
                    <Flag className="w-3.5 h-3.5" />
                    <span>إنهاء المنافسة</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Competitors live score pills */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {activeComp.competitors
              .slice()
              .sort(
                (a, b) =>
                  (liveScoreMap.get(b.uid)?.points ?? 0) -
                  (liveScoreMap.get(a.uid)?.points ?? 0)
              )
              .map((c) => {
                const st = liveScoreMap.get(c.uid) ?? { points: 0, wrongs: 0, timeMs: 0 };
                const isMe = c.uid === profile.uid;
                const missedCurrent =
                  activeQuestion?.wrongPlayerIds?.includes(c.uid) ?? false;
                const wonCurrent = activeQuestion?.winnerId === c.uid;
                return (
                  <div
                    key={c.uid}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 text-xs font-black shrink-0 ${
                      wonCurrent
                        ? 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                        : missedCurrent
                        ? 'bg-[#FFDFE0]/70 border-[#FF4B4B] text-[#EA2B2B]'
                        : isMe
                        ? 'bg-[#DDF4FF] border-[#1CB0F6] text-[#1899D6]'
                        : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#3C3C3C]'
                    }`}
                  >
                    <span className="max-w-[130px] truncate">{c.name}</span>
                    <span className="font-latin px-1.5 py-0.5 rounded-md bg-white border border-black/10 text-[#1899D6]">
                      {st.points} ن
                    </span>
                  </div>
                );
              })}
          </div>
        </div>

        {/* 3-Second Sync Countdown Stage (Between questions & before Q1) */}
        {activeComp.phase === 'countdown' && (
          <div className="duo-card p-6 sm:p-10 flex flex-col items-center justify-center text-center gap-5 bg-gradient-to-b from-[#F8EDFF] to-white border-2 border-[#CE82FF]">
            {!isInitialCountdown && activeQuestion && (
              <div
                className={`w-full max-w-2xl p-4 sm:p-5 rounded-2xl border-2 flex flex-col gap-2.5 text-right ${
                  activeQuestion.status === 'correct'
                    ? 'bg-[#D7FFB8]/60 border-[#58CC02]'
                    : 'bg-[#FFDFE0]/60 border-[#FF4B4B]'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {activeQuestion.status === 'correct' ? (
                    <div className="flex items-center gap-2 text-[#46A302] font-black text-sm sm:text-base">
                      <DuoCheckBadge className="w-6 h-6" />
                      <span>
                        حصل على النقطة: {activeQuestion.winnerName} في{' '}
                        {formatTimeSeconds(activeQuestion.winnerTimeMs)}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-[#EA2B2B] font-black text-sm sm:text-base">
                      <DuoCrossBadge className="w-6 h-6" />
                      <span>انتهى السؤال دون إجابة صحيحة</span>
                    </div>
                  )}
                  <span className="font-latin text-xs font-black text-[#777777]">
                    س{activeQuestion.orderIndex}
                  </span>
                </div>

                {activeQuestion.question.correctIndex >= 0 && (
                  <div className="p-2.5 rounded-xl bg-white border border-[#58CC02] text-xs sm:text-sm font-black text-[#46A302]">
                    <span className="ml-1.5">الإجابة الصحيحة:</span>
                    <MathText
                      text={
                        activeQuestion.question.choices[
                          activeQuestion.question.correctIndex
                        ] || ''
                      }
                      className="inline"
                    />
                  </div>
                )}

                {(activeQuestion.question.explanation ||
                  activeQuestion.question.explanationChart ||
                  activeQuestion.question.explanationFigure) && (
                  <div className="p-3 rounded-xl bg-white/95 border border-[#E5E5E5] text-xs sm:text-sm font-bold text-[#3C3C3C] flex flex-col gap-2">
                    <span className="font-black text-[#9A6B00] text-[11px]">شرح الإجابة:</span>
                    {activeQuestion.question.explanation && (
                      <MathText text={activeQuestion.question.explanation} />
                    )}
                    {activeQuestion.question.explanationChart && (
                      <ChartView chart={activeQuestion.question.explanationChart} />
                    )}
                    {activeQuestion.question.explanationFigure && (
                      <FigureView figure={activeQuestion.question.explanationFigure} compact />
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col items-center gap-3">
              <div className="w-28 h-28 rounded-full bg-[#A560E8] border-4 border-b-[8px] border-[#8938D6] text-white flex items-center justify-center shadow-lg">
                <span className="font-latin text-5xl font-black">
                  {Math.max(1, countdownRemainingSec)}
                </span>
              </div>
              <h2 className="text-xl sm:text-2xl font-black text-[#3C3C3C]">
                {isInitialCountdown
                  ? 'استعدوا! سيظهر السؤال الأول بالتزامن خلال ثوانٍ...'
                  : activeComp.currentIndex + 1 < activeComp.totalQuestions
                  ? `السؤال التالي (${activeComp.currentIndex + 2} / ${activeComp.totalQuestions}) يظهر بعد...`
                  : 'اكتملت الأسئلة! جاري إظهار النتائج النهائية...'}
              </h2>
            </div>
          </div>
        )}

        {/* Active Synchronized Question + Choices + Live Whiteboard */}
        {activeComp.phase === 'question' && activeQuestion && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            {/* Right/Top Column: Question, Chart, and Choices */}
            <div className="lg:col-span-6 duo-card p-4 sm:p-5 flex flex-col gap-4">
              <div className="flex items-center justify-between gap-2 pb-2.5 border-b-2 border-[#F0F0F0]">
                <div className="flex items-center gap-2">
                  <span className="font-latin px-3 py-1 rounded-xl bg-[#A560E8] text-white text-xs font-black">
                    سؤال {activeQuestion.orderIndex}
                  </span>
                  {activeQuestion.question.sourceTitle && (
                    <span className="text-[11px] font-bold text-[#777777] truncate max-w-[180px]">
                      من: {activeQuestion.question.sourceTitle}
                    </span>
                  )}
                </div>
                <span className="text-[11px] font-black text-[#1899D6]">
                  الأسرع بالإجابة الصحيحة يكسب النقطة ⚡
                </span>
              </div>

              <MathText
                text={activeQuestion.question.text}
                className="text-base sm:text-lg font-black text-[#3C3C3C] leading-relaxed"
              />

              {activeQuestion.question.chart && (
                <ChartView chart={activeQuestion.question.chart} />
              )}
              {activeQuestion.question.figure && (
                <FigureView figure={activeQuestion.question.figure} />
              )}

              {isQuestionResolved && activeQuestion.status === 'correct' && (
                <div className="p-3.5 rounded-2xl bg-[#D7FFB8] border-2 border-[#58CC02] text-[#46A302] text-xs sm:text-sm font-black flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <DuoCheckBadge className="w-5 h-5 shrink-0" />
                    <span>
                      الأسرع بالإجابة الصحيحة: {activeQuestion.winnerName} (
                      {formatTimeSeconds(activeQuestion.winnerTimeMs)})
                    </span>
                  </div>
                  <span className="text-[11px] font-extrabold text-[#46A302]/80 shrink-0">
                    جاري الانتقال...
                  </span>
                </div>
              )}

              {isQuestionResolved && activeQuestion.status === 'unanswered' && (
                <div className="p-3.5 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-[#EA2B2B] text-xs sm:text-sm font-black flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <DuoCrossBadge className="w-5 h-5 shrink-0" />
                    <span>انتهى السؤال — الإجابة الصحيحة بالأخضر</span>
                  </div>
                  <span className="text-[11px] font-extrabold shrink-0">
                    جاري الانتقال...
                  </span>
                </div>
              )}

              {raceNotice && (
                <div className="p-3 rounded-xl bg-[#FFF4CC] border-2 border-[#FFC800] text-[#9A6B00] text-xs sm:text-sm font-black flex items-center gap-2">
                  <Timer className="w-4 h-4 shrink-0" />
                  <span>{raceNotice}</span>
                </div>
              )}

              {!isQuestionResolved && hasWrongAttempt && (
                <div className="p-3 rounded-xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-[#EA2B2B] text-xs sm:text-sm font-black flex items-center gap-2">
                  <XCircle className="w-5 h-5 shrink-0" />
                  <span>
                    إجابتك غير صحيحة لهذا السؤال — تم قفل الاختيارات عليك وستظهر الإجابة الصحيحة فور حسم السؤال.
                  </span>
                </div>
              )}

              {!isCompetitor && (
                <div className="p-3 rounded-xl bg-[#FFF4CC] border-2 border-[#FFC800] text-[#9A6B00] text-xs font-black flex items-center gap-2">
                  <Eye className="w-4 h-4 shrink-0" />
                  <span>أنت في وضع المشاهدة والمراقبة لهذه المنافسة.</span>
                </div>
              )}

              <div className="flex flex-col gap-2.5">
                {activeQuestion.question.choices.map((ch, idx) => {
                  const isCorrectOption = idx === activeQuestion.question.correctIndex;
                  const isMyPickedOption = myAttempt?.choiceIndex === idx;
                  const isSelectedPending = isQuestionOpen && pendingChoiceIdx === idx;
                  const lockedForMe =
                    !isCompetitor || !isQuestionOpen || hasWrongAttempt || answering;

                  let btnStyle =
                    'bg-white border-[#E5E5E5] hover:border-[#1CB0F6] hover:bg-[#DDF4FF]/40 text-[#3C3C3C] cursor-pointer';
                  let letterStyle =
                    'bg-[#F7F7F7] border-[#E5E5E5] text-[#1899D6]';

                  if (isQuestionResolved) {
                    if (isCorrectOption) {
                      btnStyle =
                        'bg-[#D7FFB8] border-[#58CC02] text-[#46A302] cursor-default shadow-sm';
                      letterStyle = 'bg-[#58CC02] border-[#46A302] text-white';
                    } else {
                      btnStyle =
                        'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B] cursor-default';
                      letterStyle = 'bg-[#FF4B4B] border-[#EA2B2B] text-white';
                    }
                  } else if (hasWrongAttempt) {
                    if (isMyPickedOption) {
                      btnStyle =
                        'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B] cursor-not-allowed';
                      letterStyle = 'bg-[#FF4B4B] border-[#EA2B2B] text-white';
                    } else {
                      btnStyle =
                        'bg-[#F7F7F7] border-[#E5E5E5] text-[#777777] opacity-65 cursor-not-allowed';
                    }
                  } else if (isSelectedPending) {
                    btnStyle =
                      'bg-[#F3E8FF] border-[#A560E8] text-[#5C1A99] cursor-pointer shadow-sm';
                    letterStyle = 'bg-[#A560E8] border-[#8938D6] text-white';
                  } else if (lockedForMe) {
                    btnStyle =
                      'bg-[#F7F7F7] border-[#E5E5E5] text-[#777777] opacity-70 cursor-not-allowed';
                  }

                  return (
                    <button
                      key={idx}
                      type="button"
                      disabled={lockedForMe}
                      onClick={() => {
                        if (lockedForMe) return;
                        setPendingChoiceIdx(idx);
                        playDuoSound('pop');
                      }}
                      className={`duo-btn w-full text-right p-3.5 rounded-2xl border-2 border-b-4 flex items-center gap-3 transition-all ${btnStyle}`}
                    >
                      <span
                        className={`w-8 h-8 rounded-xl border-2 font-black text-sm flex items-center justify-center shrink-0 ${letterStyle}`}
                      >
                        {CHOICE_LETTERS[idx] ?? idx + 1}
                      </span>
                      <MathText
                        text={ch}
                        className="text-sm sm:text-base font-extrabold flex-1"
                      />
                      {isQuestionResolved && isCorrectOption && (
                        <span className="flex items-center gap-1 text-xs font-black text-[#46A302] bg-white/80 px-2 py-0.5 rounded-lg border border-[#58CC02] shrink-0">
                          <CheckCircle2 className="w-4 h-4" />
                          <span>الصحيحة</span>
                        </span>
                      )}
                      {isQuestionResolved && !isCorrectOption && (
                        <span className="flex items-center gap-1 text-xs font-black text-[#EA2B2B] shrink-0">
                          {isMyPickedOption && (
                            <span className="text-[10px] bg-white/80 px-1.5 py-0.5 rounded-md border border-[#FF4B4B]">
                              اختيارك
                            </span>
                          )}
                          <XCircle className="w-4 h-4" />
                        </span>
                      )}
                      {!isQuestionResolved && hasWrongAttempt && isMyPickedOption && (
                        <XCircle className="w-4 h-4 text-[#EA2B2B] shrink-0" />
                      )}
                      {isSelectedPending && (
                        <span className="text-[11px] font-black px-2 py-0.5 rounded-lg bg-[#A560E8] text-white shrink-0">
                          محدد
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Inline Answer Confirmation Bar */}
              {isQuestionOpen && isCompetitor && !hasWrongAttempt && pendingChoiceIdx !== null && (
                <div className="p-3.5 rounded-2xl bg-[#F3E8FF]/70 border-2 border-[#A560E8] flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs sm:text-sm font-black text-[#5C1A99]">
                    <span className="w-7 h-7 rounded-xl bg-[#A560E8] text-white flex items-center justify-center shrink-0">
                      {CHOICE_LETTERS[pendingChoiceIdx] ?? pendingChoiceIdx + 1}
                    </span>
                    <span>هل تؤكد اعتماد هذه الإجابة؟</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={answering}
                      onClick={() => setPendingChoiceIdx(null)}
                      className="duo-btn px-3.5 py-2 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#777777] hover:text-[#3C3C3C] cursor-pointer disabled:opacity-50"
                    >
                      تغيير
                    </button>
                    <button
                      type="button"
                      disabled={answering}
                      onClick={() => void handleAnswerChoice(pendingChoiceIdx)}
                      className="duo-btn flex items-center gap-1.5 px-5 py-2 rounded-xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-xs sm:text-sm font-black cursor-pointer disabled:opacity-60"
                    >
                      {answering ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4" />
                      )}
                      <span>{answering ? 'جاري التأكيد...' : 'تأكيد الإجابة'}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Left/Bottom Column: Live Whiteboard (Scratchpad for Competitor / Monitor for Observer) */}
            <div className="lg:col-span-6 duo-card p-4 sm:p-5 flex flex-col gap-3">
              {isCompetitor ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <PenTool className="w-4 h-4 text-[#1899D6]" />
                      <h3 className="text-sm font-black text-[#3C3C3C]">
                        سبورتك للحل والخطوات (تُحفظ مع نتائج السؤال)
                      </h3>
                    </div>
                  </div>
                  <WhiteboardCanvas
                    strokes={myStrokes}
                    onStrokesChange={handleMyStrokesChange}
                    disabled={!isQuestionOpen}
                    lockTitle="تم حسم السؤال"
                    lockSubtitle="ستُفتح السبورة تلقائياً للسؤال التالي"
                    syncIntervalMs={280}
                    heightClass="h-[300px] sm:h-[380px] lg:h-[430px]"
                  />
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Eye className="w-4 h-4 text-[#8938D6]" />
                      <h3 className="text-sm font-black text-[#3C3C3C]">
                        متابعة سبورات المتنافسين مباشرة
                      </h3>
                    </div>
                    {questionBoards.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {questionBoards.map((b) => (
                          <button
                            key={b.studentId}
                            type="button"
                            onClick={() => setInspectedBoardUid(b.studentId)}
                            className={`px-2.5 py-1 rounded-lg text-[11px] font-black cursor-pointer border ${
                              inspectedBoard?.studentId === b.studentId
                                ? 'bg-[#A560E8] border-[#8938D6] text-white'
                                : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#3C3C3C]'
                            }`}
                          >
                            {b.studentName}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {inspectedBoard ? (
                    <WhiteboardCanvas
                      strokes={inspectedBoard.strokes || []}
                      onStrokesChange={() => {}}
                      viewOnly
                      viewOnlyLabel={`تشاهد سبورة: ${inspectedBoard.studentName}`}
                      heightClass="h-[300px] sm:h-[380px] lg:h-[430px]"
                    />
                  ) : (
                    <div className="h-[300px] rounded-2xl border-2 border-dashed border-[#E5E5E5] bg-[#F7F7F7] flex items-center justify-center text-sm font-bold text-[#777777]">
                      لم يبدأ أي متنافس بالكتابة على السبورة في هذا السؤال بعد
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ------------------ 3) SETUP / LOBBY SCREEN ------------------
  const readyQuizCount = quizPool.filter((e) => validPool(e.quiz).length > 0).length;

  return (
    <div className="flex flex-col gap-4">
      {/* Everyone can sync/import quizzes into the room */}
      <RoomQuizSyncBanner
        roomId={room.id}
        profile={profile}
        isSupervisor={isSupervisor}
        onImportedQuizPoolId={(newPoolId) => {
          if (newPoolId) {
            setSelectedPoolIds((prev) =>
              sourceMode === 'mix'
                ? Array.from(new Set([...prev, newPoolId]))
                : [newPoolId]
            );
          }
        }}
      />

      {!isSupervisor ? (
        <div className="duo-card p-8 sm:p-12 text-center flex flex-col items-center gap-4">
          <div className="w-20 h-20 rounded-3xl bg-[#FFF4CC] border-2 border-[#FFC800] flex items-center justify-center">
            <Trophy className="w-10 h-10 text-[#E5A400]" />
          </div>
          <h2 className="text-2xl font-black text-[#3C3C3C]">
            وضع المنافسة المباشرة جاهز!
          </h2>
          <p className="text-sm font-bold text-[#777777] max-w-lg">
            يقوم المشرف الآن باختيار الأسئلة وضبط المؤقت من أي اختبار مشارَك في الغرفة (اختباراتك أو اختبارات زملائك أو المشرف). يمكنك استيراد اختبار جديد بالأعلى لتشارك به في المنافسة!
          </p>
          <div className="flex items-center gap-2 text-xs font-black text-[#46A302] bg-[#D7FFB8]/60 px-4 py-2 rounded-xl border border-[#58CC02]">
            <Sparkles className="w-4 h-4" />
            <span>متاح حالياً {readyQuizCount} اختبار داخل بنك الغرفة</span>
          </div>
        </div>
      ) : (
        <div className="duo-card p-5 sm:p-6 flex flex-col gap-5 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b-2 border-[#F0F0F0]">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-2xl bg-[#FFF4CC] border-2 border-[#FFC800] text-[#E5A400] flex items-center justify-center shrink-0">
                <Trophy className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-lg sm:text-xl font-black text-[#3C3C3C]">
                  إعداد منافسة تفاعلية جديدة
                </h2>
                <p className="text-xs font-bold text-[#777777]">
                  أول من يحل السؤال يكسب النقطة، ويُقفل على الباقين مع عداد 3 ثوانٍ بين كل سؤالين وسبورة حية للجميع
                </p>
              </div>
            </div>

            {onSwitchToSlides && (
              <button
                type="button"
                onClick={onSwitchToSlides}
                className="duo-btn px-3.5 py-2 rounded-xl bg-[#F7F7F7] border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer"
              >
                التبديل لوضع PDF / الصور
              </button>
            )}
          </div>

          {/* 1. Source Mode: Single vs Mixed */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => handleSourceModeChange('single')}
              className={`p-4 rounded-2xl border-2 text-right flex items-start gap-3 cursor-pointer transition-all ${
                sourceMode === 'single'
                  ? 'bg-[#F3E8FF]/60 border-[#A560E8]'
                  : 'bg-[#F7F7F7] border-[#E5E5E5] hover:bg-white'
              }`}
            >
              <Layers className="w-5 h-5 text-[#8938D6] mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-black text-[#3C3C3C]">من اختبار واحد محدد</p>
                <p className="text-xs font-bold text-[#777777]">
                  اختر أي اختبار لك أو لأحد الطلاب ليظهر في المنافسة
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => handleSourceModeChange('mix')}
              className={`p-4 rounded-2xl border-2 text-right flex items-start gap-3 cursor-pointer transition-all ${
                sourceMode === 'mix'
                  ? 'bg-[#DDF4FF]/70 border-[#1CB0F6]'
                  : 'bg-[#F7F7F7] border-[#E5E5E5] hover:bg-white'
              }`}
            >
              <Shuffle className="w-5 h-5 text-[#1899D6] mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-black text-[#3C3C3C]">
                  ملخبط من عدة اختبارات (هنا وهنا)
                </p>
                <p className="text-xs font-bold text-[#777777]">
                  حدّد أي مجموعة اختبارات تبيها واسحب منها أسئلة متفرقة بالتوازن
                </p>
              </div>
            </button>
          </div>

          {/* Mix Distribution Sub-options */}
          {sourceMode === 'mix' && (
            <div className="flex flex-wrap items-center gap-2 p-3 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5]">
              <span className="text-xs font-black text-[#3C3C3C] ml-2">طريقة المزج:</span>
              <button
                type="button"
                onClick={() => setMixMode('total')}
                className={`px-3 py-1.5 rounded-xl text-xs font-black cursor-pointer border-2 ${
                  mixMode === 'total'
                    ? 'bg-[#1CB0F6] border-[#1899D6] text-white'
                    : 'bg-white border-[#E5E5E5] text-[#777777]'
                }`}
              >
                عدد أسئلة محدد موزّع على الاختبارات المختارة
              </button>
              <button
                type="button"
                onClick={() => setMixMode('onePerQuiz')}
                className={`px-3 py-1.5 rounded-xl text-xs font-black cursor-pointer border-2 ${
                  mixMode === 'onePerQuiz'
                    ? 'bg-[#1CB0F6] border-[#1899D6] text-white'
                    : 'bg-white border-[#E5E5E5] text-[#777777]'
                }`}
              >
                سؤال واحد عشوائي من كل اختبار محدد
              </button>
            </div>
          )}

          {/* 2. Quiz Selector List (From Supervisor + Students) */}
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-black text-[#3C3C3C]">
                اختر الاختبارات من بنك الغرفة ({quizPool.length}):
              </span>
              {sourceMode === 'mix' && quizPool.length > 1 && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedPoolIds(
                        quizPool
                          .filter((e) => validPool(e.quiz).length > 0)
                          .map((e) => e.poolId)
                      )
                    }
                    className="text-xs font-black text-[#1899D6] hover:underline cursor-pointer"
                  >
                    تحديد الكل
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedPoolIds([])}
                    className="text-xs font-black text-[#EA2B2B] hover:underline cursor-pointer"
                  >
                    إلغاء الكل
                  </button>
                </div>
              )}
            </div>

            {myLoading && sharedLoading && quizPool.length === 0 ? (
              <div className="p-6 text-center text-xs font-bold text-[#777777]">
                جاري تحميل اختبارات الغرفة...
              </div>
            ) : quizPool.length === 0 ? (
              <div className="p-6 rounded-2xl bg-[#F7F7F7] border-2 border-dashed border-[#E5E5E5] text-center text-xs sm:text-sm font-bold text-[#777777]">
                لا توجد اختبارات مضافة في الغرفة بعد. استخدم زر «استيراد اختبار JSON للغرفة» بالأعلى أو اطلب من الطلاب الدخول لتمت مشاركة اختباراتهم تلقائياً.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 max-h-[260px] overflow-y-auto p-0.5">
                {quizPool.map((entry) => {
                  const readyLen = validPool(entry.quiz).length;
                  const checked = selectedPoolIds.includes(entry.poolId);
                  return (
                    <button
                      key={entry.poolId}
                      type="button"
                      disabled={readyLen === 0}
                      onClick={() => togglePoolQuiz(entry.poolId)}
                      className={`p-3 rounded-2xl border-2 text-right flex flex-col gap-1.5 transition-all ${
                        readyLen === 0
                          ? 'opacity-45 bg-[#F7F7F7] border-[#E5E5E5] cursor-not-allowed'
                          : checked
                          ? 'bg-[#D7FFB8]/50 border-[#58CC02] cursor-pointer'
                          : 'bg-white border-[#E5E5E5] hover:border-[#1CB0F6] cursor-pointer'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-xs sm:text-sm font-black text-[#3C3C3C] line-clamp-2">
                          {entry.quiz.title}
                        </span>
                        <span className="font-latin px-2 py-0.5 rounded-lg bg-[#F7F7F7] border border-[#E5E5E5] text-[11px] font-black text-[#1899D6] shrink-0">
                          {readyLen} س
                        </span>
                      </div>
                      <span
                        className={`text-[11px] font-extrabold truncate ${
                          entry.isMine ? 'text-[#8938D6]' : 'text-[#46A302]'
                        }`}
                      >
                        {entry.isMine
                          ? 'من اختباراتك'
                          : entry.authorRole === 'supervisor'
                          ? `من المشرف: ${entry.authorName}`
                          : `من الطالب: ${entry.authorName}`}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 3. Question Count + Shuffle Options */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs sm:text-sm font-black text-[#3C3C3C]">
                  عدد الأسئلة في المنافسة:
                </span>
                <span className="font-latin text-xs font-black text-[#1899D6]">
                  المتاح: {maxAvailable}
                </span>
              </div>

              {sourceMode === 'mix' && mixMode === 'onePerQuiz' ? (
                <p className="text-xs font-bold text-[#777777]">
                  سيتم أخذ سؤال واحد من كل اختبار محدد ({maxAvailable} سؤال)
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={Math.max(1, maxAvailable)}
                    value={questionCount}
                    onChange={(e) =>
                      setQuestionCount(
                        Math.max(1, Math.min(Math.max(1, maxAvailable), Number(e.target.value) || 1))
                      )
                    }
                    className="font-latin w-20 px-3 py-1.5 rounded-xl bg-white border-2 border-[#E5E5E5] text-sm font-black text-center text-[#3C3C3C]"
                  />
                  {[5, 10, 15, 20, maxAvailable]
                    .filter((n, i, arr) => n > 0 && n <= maxAvailable && arr.indexOf(n) === i)
                    .map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setQuestionCount(n)}
                        className={`font-latin px-2.5 py-1.5 rounded-xl text-xs font-black border-2 cursor-pointer ${
                          questionCount === n
                            ? 'bg-[#58CC02] border-[#46A302] text-white'
                            : 'bg-white border-[#E5E5E5] text-[#777777]'
                        }`}
                      >
                        {n === maxAvailable ? `الكل (${n})` : n}
                      </button>
                    ))}
                </div>
              )}

              <div className="flex flex-wrap gap-3 pt-1">
                <label className="flex items-center gap-2 text-xs font-black text-[#3C3C3C] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={shuffleQuestions}
                    onChange={(e) => setShuffleQuestions(e.target.checked)}
                    className="w-4 h-4 accent-[#58CC02]"
                  />
                  <span>ترتيب عشوائي للأسئلة</span>
                </label>

                <label className="flex items-center gap-2 text-xs font-black text-[#3C3C3C] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={shuffleChoices}
                    onChange={(e) => setShuffleChoices(e.target.checked)}
                    className="w-4 h-4 accent-[#58CC02]"
                  />
                  <span>خلط الخيارات</span>
                </label>
              </div>
            </div>

            {/* 4. Timer Configuration */}
            <div className="p-4 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-[#1899D6]" />
                <span className="text-xs sm:text-sm font-black text-[#3C3C3C]">
                  إعدادات المؤقت:
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    { id: 'perQuestion', label: 'لكل سؤال' },
                    { id: 'total', label: 'لكل الاختبار' },
                    { id: 'none', label: 'بدون مؤقت' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setTiming(opt.id)}
                    className={`py-2 px-2 rounded-xl border-2 text-xs font-black cursor-pointer ${
                      timing === opt.id
                        ? 'bg-[#1CB0F6] border-[#1899D6] text-white'
                        : 'bg-white border-[#E5E5E5] text-[#777777]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {timing === 'perQuestion' && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {PER_Q_PRESETS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setPerQuestionSec(s)}
                      className={`font-latin px-2.5 py-1 rounded-xl text-xs font-black border-2 cursor-pointer ${
                        perQuestionSec === s
                          ? 'bg-[#FFC800] border-[#E5A400] text-[#3C3C3C]'
                          : 'bg-white border-[#E5E5E5] text-[#777777]'
                      }`}
                    >
                      {s}ث
                    </button>
                  ))}
                </div>
              )}

              {timing === 'total' && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {TOTAL_MIN_PRESETS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setTotalMinutes(m)}
                      className={`font-latin px-2.5 py-1 rounded-xl text-xs font-black border-2 cursor-pointer ${
                        totalMinutes === m
                          ? 'bg-[#FFC800] border-[#E5A400] text-[#3C3C3C]'
                          : 'bg-white border-[#E5E5E5] text-[#777777]'
                      }`}
                    >
                      {m}د
                    </button>
                  ))}
                </div>
              )}

              {timing === 'none' && (
                <p className="text-[11px] font-bold text-[#777777]">
                  يستمر السؤال حتى يجيب أحد المتنافسين إجابة صحيحة أو يتفق الكل على الإجابة، مع تسجيل الوقت بالثواني.
                </p>
              )}
            </div>
          </div>

          {/* 5. Supervisor participation & Custom Title */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
            <label className="p-3.5 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] flex items-center justify-between gap-3 cursor-pointer">
              <div className="flex items-center gap-2.5">
                <UserCheck className="w-5 h-5 text-[#46A302] shrink-0" />
                <div>
                  <p className="text-xs sm:text-sm font-black text-[#3C3C3C]">
                    مشاركة المشرف في المنافسة والحل
                  </p>
                  <p className="text-[11px] font-bold text-[#777777]">
                    {participants.length === 0
                      ? 'لا يوجد طلاب بعد — يمكنك التجربة واللعب منفرداً'
                      : `المتنافسون: ${participants.length} طالب${includeSupervisor ? ' + المشرف' : ''}`}
                  </p>
                </div>
              </div>
              <input
                type="checkbox"
                checked={includeSupervisor || participants.length === 0}
                disabled={participants.length === 0}
                onChange={(e) => setIncludeSupervisor(e.target.checked)}
                className="w-5 h-5 accent-[#58CC02]"
              />
            </label>

            <input
              type="text"
              maxLength={120}
              value={customTitle}
              onChange={(e) => setCustomTitle(e.target.value)}
              placeholder="عنوان المنافسة (اختياري — يتحدد تلقائياً)"
              className="px-4 py-3.5 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#A560E8] focus:bg-white outline-none text-sm font-bold text-[#3C3C3C]"
            />
          </div>

          {setupError && (
            <div className="p-3 rounded-xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-xs sm:text-sm font-black text-[#EA2B2B]">
              {setupError}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t-2 border-[#F0F0F0]">
            <div className="flex items-center gap-2 text-xs font-bold text-[#777777]">
              <Users className="w-4 h-4 text-[#58CC02]" />
              <span>
                {participants.length > 0
                  ? `${participants.length} طالب متصل حالياً`
                  : 'وضع التجربة الفردي جاهز (أو انتظر انضمام الطلاب)'}
              </span>
            </div>

            <button
              type="button"
              disabled={creatingComp || maxAvailable === 0 || selectedPoolIds.length === 0}
              onClick={() => void handleStartCompetition()}
              className="duo-btn flex items-center gap-2 px-8 py-3.5 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-[5px] border-[#46A302] text-white text-base font-black cursor-pointer disabled:opacity-50"
            >
              {creatingComp ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Play className="w-5 h-5 fill-current" />
              )}
              <span>
                {creatingComp ? 'جاري تجهيز المنافسة...' : 'بدء المنافسة للجميع الآن'}
              </span>
            </button>
          </div>
        </div>
      )}

      {creatingComp && (
        <DuoLoading
          variant="overlay"
          title="جاري تجهيز المنافسة وبناء الأسئلة للجميع..."
          subtitle="سيبدأ العد التنازلي خلال لحظات لجميع المتنافسين"
          accent="purple"
        />
      )}
    </div>
  );
};
