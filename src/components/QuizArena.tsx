import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  ArrowRight,
  Ban,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eraser,
  Eye,
  EyeOff,
  FilePlus2,
  FileText,
  Flag,
  ImagePlus,
  ListChecks,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Minus,
  PenTool,
  Plus,
  Presentation,
  RotateCcw,
  Search,
  Send,
  SkipForward,
  Sparkles,
  Timer,
  Trash2,
  Type,
  Unlock,
  Upload,
  Users,
  X,
  ZoomIn,
} from 'lucide-react';
import {
  compressImageToDataUrl,
  db,
  getTimestampMillis,
  handleFirestoreError,
  OperationType,
} from '../firebase';
import { compressSlideImageToDataUrl, renderPdfToSlideImages } from '../pdfUtils';
import type {
  ExplainLayer,
  InteractiveSlide,
  Participant,
  Question,
  QuizChart,
  QuizQuestion,
  Room,
  SharedExplainBoard,
  SlideLayer,
  Stroke,
  StudentBoard,
  UserProfile,
} from '../types';
import {
  DuoCheckBadge,
  DuoCrossBadge,
  DuoGemIcon,
  playDuoSound,
} from './DuoIcons';
import { solveQuestionWithAi, getAiConfig, AiKeyError, type AiSolution } from '../aiClient';
import AiKeyModal from './AiKeyModal';
import {
  loadQuizDraft,
  loadSessionSnapshot,
  mergeActiveRoomSnapshot,
  saveQuizDraft,
  type StoredQuizAnswerMeta,
  type StoredRoomSnapshot,
} from '../localDraftStore';
import {
  doesStrokeIntersectEraser,
  renderStrokesToDataUrl,
  WhiteboardCanvas,
  WhiteboardPreview,
  ZoomablePreviewStage,
} from './WhiteboardCanvas';
import { MathText } from '../mathText';
import { ChartView } from './ChartView';
import {
  buildRoomQuizPool,
  type RoomQuizEntry,
  useMyQuizzes,
  useRoomSharedQuizzes,
} from '../roomQuizzes';
import { RoomQuizSyncBanner } from './RoomQuizBank';

interface QuizArenaProps {
  room: Room;
  profile: UserProfile;
  participants: Participant[];
  isSupervisor: boolean;
}

interface PrivatePdfDoc {
  id: string;
  fileName: string;
  pages: string[];
  selectedPage: number;
}

const TIMER_PRESETS = [
  { label: 'بدون', seconds: 0 },
  { label: '30 ث', seconds: 30 },
  { label: '1 د', seconds: 60 },
  { label: '1.5 د', seconds: 90 },
  { label: '2 د', seconds: 120 },
  { label: '3 د', seconds: 180 },
  { label: '5 د', seconds: 300 },
];

function formatTimerClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatTimerArabic(totalSeconds: number): string {
  if (totalSeconds <= 0) return 'بدون مؤقت';
  if (totalSeconds < 60) return `${totalSeconds} ثانية`;
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  const minLabel =
    mins === 1 ? 'دقيقة واحدة' : mins === 2 ? 'دقيقتان' : `${mins} دقائق`;
  if (secs === 0) return minLabel;
  return `${minLabel} و ${secs} ث`;
}

export const QuizArena: React.FC<QuizArenaProps> = ({
  room,
  profile,
  participants,
  isSupervisor,
}) => {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [boards, setBoards] = useState<StudentBoard[]>([]);

  // Supervisor private draft (never synced to Firestore until "أدرج السؤال" is clicked)
  const [composerTab, setComposerTab] = useState<'text' | 'board' | 'pdf' | 'quizzes'>('text');
  const [draftText, setDraftText] = useState('');
  const [draftImage, setDraftImage] = useState('');
  const [draftBoardStrokes, setDraftBoardStrokes] = useState<Stroke[]>([]);
  const [pdfDocs, setPdfDocs] = useState<PrivatePdfDoc[]>([]);
  const [activePdfId, setActivePdfId] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfProgress, setPdfProgress] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftTimerSeconds, setDraftTimerSeconds] = useState<number>(60);
  const [insertingQuestion, setInsertingQuestion] = useState(false);

  // Room Quizzes bank (supervisor's myQuizzes + students' sharedQuizzes)
  const { myQuizzes } = useMyQuizzes(profile.uid);
  const { sharedQuizzes } = useRoomSharedQuizzes(room.id);
  const roomQuizPool = useMemo(
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
  const [selectedPoolQuizIds, setSelectedPoolQuizIds] = useState<string[]>([]);
  const [quizQuestionSearch, setQuizQuestionSearch] = useState('');
  const [includeQuizChoices, setIncludeQuizChoices] = useState(true);
  const [draftQuizAttachment, setDraftQuizAttachment] = useState<{
    choices?: string[];
    chart?: QuizChart;
    answerMeta?: StoredQuizAnswerMeta;
  } | null>(null);
  const [quizAnswerCache, setQuizAnswerCache] = useState<Record<string, StoredQuizAnswerMeta>>({});

  // Supervisor-only AI Solution & Explanation state
  const [draftAiSolution, setDraftAiSolution] = useState<AiSolution | null>(null);
  const [aiKeyModalOpen, setAiKeyModalOpen] = useState(false);
  const pendingAiActionRef = useRef<(() => void) | null>(null);
  const [draftAiLoading, setDraftAiLoading] = useState(false);
  const [draftAiError, setDraftAiError] = useState<string | null>(null);
  const [activeAiCache, setActiveAiCache] = useState<Record<string, AiSolution>>({});
  const [activeAiOpen, setActiveAiOpen] = useState(false);
  const [activeAiLoading, setActiveAiLoading] = useState(false);
  const [activeAiError, setActiveAiError] = useState<string | null>(null);

  // Explain Mode shared whiteboard state (supports simultaneous per-user layers, PDF/image slides, per-user erase & write blocking)
  const [sharedBoardExists, setSharedBoardExists] = useState(false);
  const [sharedStrokes, setSharedStrokes] = useState<Stroke[]>([]);
  const [explainLayers, setExplainLayers] = useState<ExplainLayer[]>([]);
  const [localExplainStrokes, setLocalExplainStrokes] = useState<Stroke[]>([]);
  const [explainSlides, setExplainSlides] = useState<InteractiveSlide[]>([]);
  const [explainSlideLayers, setExplainSlideLayers] = useState<SlideLayer[]>([]);
  const [localSlideExplainStrokes, setLocalSlideExplainStrokes] = useState<Stroke[]>([]);
  const [explainBusy, setExplainBusy] = useState(false);
  const [explainUploading, setExplainUploading] = useState(false);
  const [explainUploadStatus, setExplainUploadStatus] = useState('');
  const [explainUploadError, setExplainUploadError] = useState<string | null>(null);

  // Student local strokes & sync state
  const [localStrokes, setLocalStrokes] = useState<Stroke[]>([]);
  const [submittingBoard, setSubmittingBoard] = useState(false);

  // Modals (inline, never window.alert/confirm)
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  const [inspectedBoard, setInspectedBoard] = useState<StudentBoard | null>(null);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [finishingRoom, setFinishingRoom] = useState(false);
  const [gradingBusy, setGradingBusy] = useState(false);
  const [studentFullscreen, setStudentFullscreen] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const explainFileInputRef = useRef<HTMLInputElement | null>(null);
  const explainAppendModeRef = useRef<boolean>(false);
  const lastExplainEditAtRef = useRef<number>(0);
  const hydratedDraftKeyRef = useRef<string | null>(null);
  const lastInheritedQuestionIdRef = useRef<string | null>(null);
  const fallbackStartMapRef = useRef<Record<string, number>>({});
  const expiredSoundPlayedRef = useRef<string | null>(null);

  const draftStorageKey = `${profile.uid}_${room.id}`;

  // Restore supervisor's uploaded PDFs, question images, draft strokes, and AI cache on page refresh
  useEffect(() => {
    if (!isSupervisor) return;
    let cancelled = false;
    hydratedDraftKeyRef.current = null;

    void loadQuizDraft(draftStorageKey).then((saved) => {
      if (cancelled) return;
      if (saved) {
        if (saved.composerTab) setComposerTab(saved.composerTab);
        if (typeof saved.draftText === 'string') setDraftText(saved.draftText);
        if (typeof saved.draftImage === 'string') setDraftImage(saved.draftImage);
        if (Array.isArray(saved.draftBoardStrokes)) {
          setDraftBoardStrokes(saved.draftBoardStrokes);
        }
        if (Array.isArray(saved.pdfDocs)) {
          setPdfDocs(saved.pdfDocs);
        }
        if (saved.activePdfId !== undefined) {
          setActivePdfId(saved.activePdfId);
        }
        if (
          typeof saved.draftTimerSeconds === 'number' &&
          lastInheritedQuestionIdRef.current === null
        ) {
          setDraftTimerSeconds(saved.draftTimerSeconds);
        }
        if (saved.draftAiSolution) {
          setDraftAiSolution(saved.draftAiSolution);
        }
        if (saved.activeAiCache && typeof saved.activeAiCache === 'object') {
          setActiveAiCache((prev) => ({ ...saved.activeAiCache, ...prev }));
        }
        if (saved.quizAnswerCache && typeof saved.quizAnswerCache === 'object') {
          setQuizAnswerCache((prev) => ({ ...saved.quizAnswerCache, ...prev }));
        }
      }
      hydratedDraftKeyRef.current = draftStorageKey;
    });

    return () => {
      cancelled = true;
    };
  }, [isSupervisor, draftStorageKey]);

  // Persist supervisor's uploaded PDFs, question images, and drafts automatically to IndexedDB
  useEffect(() => {
    if (!isSupervisor || hydratedDraftKeyRef.current !== draftStorageKey) return;
    const timer = window.setTimeout(() => {
      void saveQuizDraft({
        key: draftStorageKey,
        composerTab,
        draftText,
        draftImage,
        draftBoardStrokes,
        pdfDocs,
        activePdfId,
        draftTimerSeconds,
        draftAiSolution,
        activeAiCache,
        quizAnswerCache,
        updatedAt: Date.now(),
      });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [
    isSupervisor,
    draftStorageKey,
    composerTab,
    draftText,
    draftImage,
    draftBoardStrokes,
    pdfDocs,
    activePdfId,
    draftTimerSeconds,
    draftAiSolution,
    activeAiCache,
    quizAnswerCache,
  ]);

  // Subscribe to published questions in the room
  useEffect(() => {
    const qPath = `rooms/${room.id}/questions`;
    const qRef = query(collection(db, 'rooms', room.id, 'questions'), where('roomId', '==', room.id));
    const unsub = onSnapshot(
      qRef,
      (snap) => {
        const list: Question[] = [];
        snap.forEach((d) => list.push(d.data() as Question));
        list.sort((a, b) => a.orderIndex - b.orderIndex);
        setQuestions(list);
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, qPath);
      }
    );
    return () => unsub();
  }, [room.id]);

  // Subscribe to Explain Mode slides (uploaded images / PDF pages)
  useEffect(() => {
    const sPath = `rooms/${room.id}/slides`;
    const sRef = query(collection(db, 'rooms', room.id, 'slides'), where('roomId', '==', room.id));
    const unsub = onSnapshot(
      sRef,
      (snap) => {
        const list: InteractiveSlide[] = [];
        snap.forEach((d) => list.push(d.data() as InteractiveSlide));
        list.sort((a, b) => a.pageIndex - b.pageIndex);
        setExplainSlides(list);
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, sPath);
      }
    );
    return () => unsub();
  }, [room.id]);

  const explainSlideIndex = room.currentSlideIndex ?? 0;
  const activeExplainSlide = useMemo(() => {
    if (explainSlideIndex <= 0 || explainSlides.length === 0) return null;
    return explainSlides.find((s) => s.pageIndex === explainSlideIndex) ?? null;
  }, [explainSlideIndex, explainSlides]);

  // Subscribe to per-user annotation layers for the active Explain Mode slide (when an image/PDF page is shown)
  useEffect(() => {
    if (!activeExplainSlide) {
      setExplainSlideLayers([]);
      setLocalSlideExplainStrokes([]);
      return;
    }
    const slideId = activeExplainSlide.id;
    const lPath = `rooms/${room.id}/slides/${slideId}/layers`;
    const lRef = query(
      collection(db, 'rooms', room.id, 'slides', slideId, 'layers'),
      where('roomId', '==', room.id),
      where('slideId', '==', slideId)
    );
    const unsub = onSnapshot(
      lRef,
      (snap) => {
        const list: SlideLayer[] = [];
        snap.forEach((d) => list.push(d.data() as SlideLayer));
        setExplainSlideLayers(list);
        const mine = list.find((l) => l.authorId === profile.uid);
        const remoteStrokes = mine?.strokes ?? [];
        if (remoteStrokes.length === 0 || Date.now() - lastExplainEditAtRef.current > 1200) {
          setLocalSlideExplainStrokes(remoteStrokes);
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, lPath);
      }
    );
    return () => unsub();
  }, [room.id, activeExplainSlide?.id, profile.uid]);

  useEffect(() => {
    lastExplainEditAtRef.current = 0;
    if (!activeExplainSlide) {
      setLocalSlideExplainStrokes([]);
      return;
    }
    const mine = explainSlideLayers.find(
      (l) => l.slideId === activeExplainSlide.id && l.authorId === profile.uid
    );
    setLocalSlideExplainStrokes(mine?.strokes ?? []);
  }, [activeExplainSlide?.id]);

  // Subscribe to synchronized Explain Mode shared whiteboard (legacy single doc + blank board collaborative layers)
  useEffect(() => {
    const sbPath = `rooms/${room.id}/sharedBoard/live`;
    const sbRef = doc(db, 'rooms', room.id, 'sharedBoard', 'live');
    const unsub = onSnapshot(
      sbRef,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as SharedExplainBoard;
          setSharedBoardExists(true);
          setSharedStrokes(data.strokes || []);
        } else {
          setSharedBoardExists(false);
          setSharedStrokes([]);
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, sbPath);
      }
    );
    return () => unsub();
  }, [room.id]);

  useEffect(() => {
    const elPath = `rooms/${room.id}/explainLayers`;
    const elRef = query(
      collection(db, 'rooms', room.id, 'explainLayers'),
      where('roomId', '==', room.id)
    );
    const unsub = onSnapshot(
      elRef,
      (snap) => {
        const list: ExplainLayer[] = [];
        snap.forEach((d) => list.push(d.data() as ExplainLayer));
        setExplainLayers(list);
        const mine = list.find((l) => l.id === profile.uid);
        const remoteStrokes = mine?.strokes ?? [];
        if (remoteStrokes.length === 0 || Date.now() - lastExplainEditAtRef.current > 1200) {
          setLocalExplainStrokes(remoteStrokes);
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, elPath);
      }
    );
    return () => unsub();
  }, [room.id, profile.uid]);

  const activePdfDoc = useMemo(
    () => pdfDocs.find((d) => d.id === activePdfId) ?? pdfDocs[0] ?? null,
    [pdfDocs, activePdfId]
  );

  const setActivePdfPage = (docId: string, pageNum: number) => {
    setPdfDocs((prev) =>
      prev.map((d) => (d.id === docId ? { ...d, selectedPage: pageNum } : d))
    );
  };

  const currentQuestion = useMemo(() => {
    if (!room.currentQuestionId) return null;
    return questions.find((q) => q.id === room.currentQuestionId) ?? null;
  }, [questions, room.currentQuestionId]);

  const latestQuestion = questions.length > 0 ? questions[questions.length - 1] : null;
  const previousTimerSeconds =
    latestQuestion && typeof latestQuestion.timerSeconds === 'number'
      ? latestQuestion.timerSeconds
      : null;

  // Automatically default each new question's timer to the previous question's timer
  useEffect(() => {
    if (!latestQuestion) return;
    if (lastInheritedQuestionIdRef.current !== latestQuestion.id) {
      lastInheritedQuestionIdRef.current = latestQuestion.id;
      if (typeof latestQuestion.timerSeconds === 'number') {
        setDraftTimerSeconds(latestQuestion.timerSeconds);
      }
    }
  }, [latestQuestion?.id, latestQuestion?.timerSeconds]);

  const activeTimerTotal = currentQuestion?.timerSeconds ?? 0;

  useEffect(() => {
    if (!currentQuestion || currentQuestion.status !== 'solving' || activeTimerTotal <= 0) {
      return;
    }
    setNowMs(Date.now());
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 250);
    return () => window.clearInterval(id);
  }, [currentQuestion?.id, currentQuestion?.status, activeTimerTotal]);

  const timerRemainingSeconds = useMemo(() => {
    if (!currentQuestion || activeTimerTotal <= 0) return null;
    if (currentQuestion.status !== 'solving') return 0;
    let startMs = getTimestampMillis(currentQuestion.createdAt);
    if (startMs <= 0) {
      if (!fallbackStartMapRef.current[currentQuestion.id]) {
        fallbackStartMapRef.current[currentQuestion.id] = Date.now();
      }
      startMs = fallbackStartMapRef.current[currentQuestion.id];
    }
    const elapsedMs = Math.max(0, nowMs - startMs);
    const remaining = Math.ceil((activeTimerTotal * 1000 - elapsedMs) / 1000);
    return Math.min(activeTimerTotal, Math.max(0, remaining));
  }, [
    currentQuestion?.id,
    currentQuestion?.status,
    currentQuestion?.createdAt,
    activeTimerTotal,
    nowMs,
  ]);

  const isTimeUp =
    Boolean(currentQuestion) &&
    currentQuestion?.status === 'solving' &&
    activeTimerTotal > 0 &&
    timerRemainingSeconds === 0;

  useEffect(() => {
    if (!currentQuestion || !isTimeUp) return;
    if (expiredSoundPlayedRef.current !== currentQuestion.id) {
      expiredSoundPlayedRef.current = currentQuestion.id;
      playDuoSound('wrong');
    }
  }, [isTimeUp, currentQuestion?.id]);

  // Subscribe to boards for the active question
  useEffect(() => {
    if (!currentQuestion) {
      setBoards([]);
      return;
    }
    const bPath = `rooms/${room.id}/questions/${currentQuestion.id}/boards`;
    const bRef = query(
      collection(db, 'rooms', room.id, 'questions', currentQuestion.id, 'boards'),
      where('roomId', '==', room.id),
      where('questionId', '==', currentQuestion.id)
    );
    const unsub = onSnapshot(
      bRef,
      (snap) => {
        const list: StudentBoard[] = [];
        snap.forEach((d) => list.push(d.data() as StudentBoard));
        setBoards(list);
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, bPath);
      }
    );
    return () => unsub();
  }, [room.id, currentQuestion?.id]);

  // Reset local strokes when switching to a new question
  const myBoard = useMemo(
    () => boards.find((b) => b.studentId === profile.uid) ?? null,
    [boards, profile.uid]
  );

  useEffect(() => {
    if (!currentQuestion) {
      setLocalStrokes([]);
      return;
    }
    if (myBoard) {
      setLocalStrokes(myBoard.strokes || []);
    } else {
      setLocalStrokes([]);
      if (!isSupervisor) {
        let cancelled = false;
        void loadSessionSnapshot<StoredRoomSnapshot>('active_room').then((snap) => {
          if (cancelled || !snap || snap.room.id !== room.id) return;
          const prevBoard = snap.boards.find(
            (b) =>
              b.questionId === currentQuestion.id &&
              (b.studentId === profile.uid || b.studentName === profile.fullNameQuad)
          );
          if (prevBoard && (prevBoard.strokes?.length ?? 0) > 0) {
            setLocalStrokes(prevBoard.strokes);
          }
        });
        return () => {
          cancelled = true;
        };
      }
    }
  }, [currentQuestion?.id, myBoard?.studentId, isSupervisor, room.id, profile.uid, profile.fullNameQuad]);

  // Sound feedback when question resolves
  const prevQStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentQuestion) {
      prevQStatusRef.current = null;
      return;
    }
    if (prevQStatusRef.current === 'solving' && currentQuestion.status === 'correct') {
      playDuoSound('correct');
    } else if (prevQStatusRef.current === 'solving' && currentQuestion.status === 'unanswered') {
      playDuoSound('wrong');
    } else if (prevQStatusRef.current === null && currentQuestion.status === 'solving') {
      playDuoSound('pop');
    }
    prevQStatusRef.current = currentQuestion.status;
  }, [currentQuestion?.id, currentQuestion?.status]);

  // Continuously mirror live quiz & explain data to IndexedDB for lossless database failover
  useEffect(() => {
    const timer = window.setTimeout(() => {
      let mergedBoards = boards;
      if (!isSupervisor && currentQuestion && localStrokes.length > 0) {
        const hasMine = boards.some((b) => b.studentId === profile.uid);
        if (hasMine) {
          mergedBoards = boards.map((b) =>
            b.studentId === profile.uid ? { ...b, strokes: localStrokes } : b
          );
        } else {
          mergedBoards = [
            ...boards,
            {
              studentId: profile.uid,
              studentName: profile.fullNameQuad,
              roomId: room.id,
              questionId: currentQuestion.id,
              strokes: localStrokes,
              submitted: false,
              verdict: 'pending',
            },
          ];
        }
      }

      const mergedExplainLayers =
        localExplainStrokes.length > 0 &&
        !explainLayers.some((l) => l.authorId === profile.uid)
          ? [
              ...explainLayers,
              {
                id: profile.uid,
                roomId: room.id,
                authorId: profile.uid,
                authorName: profile.fullNameQuad,
                strokes: localExplainStrokes,
              },
            ]
          : explainLayers.map((l) =>
              l.authorId === profile.uid && localExplainStrokes.length > 0
                ? { ...l, strokes: localExplainStrokes }
                : l
            );

      void mergeActiveRoomSnapshot(room.id, {
        room,
        participants,
        questions,
        slides: explainSlides,
        explainLayers: mergedExplainLayers,
        slideLayers: explainSlideLayers,
        sharedBoard: sharedBoardExists
          ? {
              roomId: room.id,
              strokes: sharedStrokes,
              updatedBy: profile.uid,
              updatedByName: profile.fullNameQuad,
            }
          : null,
        boards: mergedBoards,
        myRole: isSupervisor ? 'supervisor' : 'student',
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [
    room,
    participants,
    questions,
    explainSlides,
    explainLayers,
    explainSlideLayers,
    sharedBoardExists,
    sharedStrokes,
    boards,
    localStrokes,
    localExplainStrokes,
    currentQuestion?.id,
    isSupervisor,
    profile.uid,
    profile.fullNameQuad,
  ]);

  // Pending submission queue ordered by server timestamp (first to press "تم" = الطالب الأول)
  const pendingQueue = useMemo(() => {
    return boards
      .filter((b) => b.submitted && b.verdict === 'pending')
      .sort((a, b) => getTimestampMillis(a.updatedAt) - getTimestampMillis(b.updatedAt));
  }, [boards]);

  const activeReviewBoard = pendingQueue[0] ?? null;

  // Supervisor: upload private question image
  const handleImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDraftError(null);
    try {
      const compressed = await compressImageToDataUrl(file);
      setDraftImage(compressed);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'تعذر تحميل الصورة');
    } finally {
      e.target.value = '';
    }
  };

  // Supervisor: upload one or multiple private PDFs and append them to the question library
  const handlePdfPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const pickedFiles: File[] = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (pickedFiles.length === 0) return;

    const validPdfs = pickedFiles.filter(
      (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    );
    if (validPdfs.length === 0) {
      setDraftError('يرجى اختيار ملف PDF صالح');
      return;
    }

    setDraftError(null);
    setPdfLoading(true);
    setPdfProgress('جاري قراءة صفحات ملفات PDF...');
    const addedDocs: PrivatePdfDoc[] = [];

    try {
      for (let i = 0; i < validPdfs.length; i++) {
        const file = validPdfs[i];
        const pages = await renderPdfToSlideImages(
          file,
          (current, total) => {
            setPdfProgress(
              `ملف (${i + 1}/${validPdfs.length}): ${file.name} — صفحة ${current} من ${total} (محلياً لدى المشرف فقط)...`
            );
          },
          30
        );
        if (pages.length > 0) {
          addedDocs.push({
            id: `pdf_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
            fileName: file.name,
            pages,
            selectedPage: 1,
          });
        }
      }

      if (addedDocs.length === 0) {
        setDraftError('لم يتم العثور على صفحات صالحة في الملفات المختارة');
        return;
      }

      setPdfDocs((prev) => [...prev, ...addedDocs]);
      setActivePdfId(addedDocs[0].id);
      setComposerTab('pdf');
      playDuoSound('pop');
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'تعذر قراءة ملف PDF');
    } finally {
      setPdfLoading(false);
      setPdfProgress('');
    }
  };

  // Helper: call built-in client-side Gemini AI directly (works without backend server on Netlify)
  const requestAiSolve = async (
    questionText: string,
    imageDataUrl: string
  ): Promise<AiSolution> => {
    return solveQuestionWithAi(questionText, imageDataUrl);
  };

  const getDraftPayload = () => {
    let finalImageData = '';
    if (composerTab === 'pdf' && activePdfDoc && activePdfDoc.pages.length > 0) {
      finalImageData = activePdfDoc.pages[activePdfDoc.selectedPage - 1] ?? '';
    } else if (composerTab === 'board') {
      if (draftBoardStrokes.length > 0) {
        finalImageData = renderStrokesToDataUrl(draftBoardStrokes);
      } else if (draftImage) {
        finalImageData = draftImage;
      }
    } else {
      finalImageData = draftImage;
      if (!finalImageData && draftBoardStrokes.length > 0) {
        finalImageData = renderStrokesToDataUrl(draftBoardStrokes);
      }
    }
    return {
      text: draftText.trim().slice(0, 1000),
      imageData: finalImageData,
    };
  };

  const handleAskAiForDraft = async () => {
    if (!isSupervisor || draftAiLoading) return;
    const payload = getDraftPayload();
    if (!payload.text && !payload.imageData) {
      setDraftAiError('يرجى كتابة نص السؤال أو تحديد صفحة PDF أو رفع صورة أولاً ليتمكن الذكاء الاصطناعي من حلها.');
      return;
    }
    if (!getAiConfig()) {
      pendingAiActionRef.current = handleAskAiForDraft;
      setAiKeyModalOpen(true);
      return;
    }
    setDraftAiError(null);
    setDraftAiLoading(true);
    try {
      const result = await requestAiSolve(payload.text, payload.imageData);
      setDraftAiSolution(result);
      playDuoSound('pop');
    } catch (err) {
      if (err instanceof AiKeyError) {
        pendingAiActionRef.current = null;
        setAiKeyModalOpen(true);
      }
      setDraftAiError(
        err instanceof Error ? err.message : 'تعذر الاتصال بالذكاء الاصطناعي'
      );
    } finally {
      setDraftAiLoading(false);
    }
  };

  const handleAskAiForActiveQuestion = async () => {
    if (!isSupervisor || !currentQuestion || activeAiLoading) return;
    if (activeAiCache[currentQuestion.id]) {
      setActiveAiOpen((prev) => !prev);
      return;
    }
    if (!getAiConfig()) {
      pendingAiActionRef.current = handleAskAiForActiveQuestion;
      setAiKeyModalOpen(true);
      return;
    }
    setActiveAiOpen(true);
    setActiveAiError(null);
    setActiveAiLoading(true);
    try {
      const result = await requestAiSolve(
        currentQuestion.text || '',
        currentQuestion.imageData || ''
      );
      setActiveAiCache((prev) => ({ ...prev, [currentQuestion.id]: result }));
      playDuoSound('pop');
    } catch (err) {
      if (err instanceof AiKeyError) {
        pendingAiActionRef.current = null;
        setAiKeyModalOpen(true);
      }
      setActiveAiError(
        err instanceof Error ? err.message : 'تعذر الاتصال بالذكاء الاصطناعي'
      );
    } finally {
      setActiveAiLoading(false);
    }
  };

  const publishQuestionToRoom = async (params: {
    text: string;
    imageData: string;
    choices?: string[];
    chart?: QuizChart;
    sourceQuizTitle?: string;
    answerMeta?: StoredQuizAnswerMeta;
  }) => {
    if (!isSupervisor || insertingQuestion) return;
    setDraftError(null);
    setInsertingQuestion(true);

    const newQId = `q_${Date.now()}`;
    const orderIndex = questions.length + 1;
    const safeTimerSeconds = Math.max(0, Math.min(3600, Math.round(draftTimerSeconds)));

    try {
      const batch = writeBatch(db);
      const qDocRef = doc(db, 'rooms', room.id, 'questions', newQId);
      const payload: Record<string, unknown> = {
        id: newQId,
        roomId: room.id,
        orderIndex,
        text: params.text.trim().slice(0, 2000),
        imageData: params.imageData,
        status: 'solving',
        attemptsUsed: 0,
        wrongStudentIds: [],
        winnerId: '',
        winnerName: '',
        timerSeconds: safeTimerSeconds,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (params.choices && params.choices.length > 0) {
        payload.choices = params.choices.slice(0, 8);
      }
      if (params.chart) {
        payload.chart = params.chart;
      }
      if (params.sourceQuizTitle) {
        payload.sourceQuizTitle = params.sourceQuizTitle.slice(0, 120);
      }
      batch.set(qDocRef, payload);
      batch.update(doc(db, 'rooms', room.id), {
        currentQuestionId: newQId,
        questionCount: orderIndex,
        updatedAt: serverTimestamp(),
      });
      await batch.commit();

      if (params.answerMeta) {
        setQuizAnswerCache((prev) => ({ ...prev, [newQId]: params.answerMeta! }));
      }
      if (draftAiSolution) {
        setActiveAiCache((prev) => ({ ...prev, [newQId]: draftAiSolution }));
        setActiveAiOpen(true);
      } else {
        setActiveAiOpen(false);
      }
      setDraftText('');
      setDraftImage('');
      setDraftBoardStrokes([]);
      setDraftQuizAttachment(null);
      setDraftAiSolution(null);
      setDraftAiError(null);
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `rooms/${room.id}/questions/${newQId}`);
    } finally {
      setInsertingQuestion(false);
    }
  };

  // Supervisor: publish question to everyone (supports text, uploaded image, chosen PDF page, supervisor's private whiteboard, or imported quiz question)
  const handleInsertQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSupervisor || insertingQuestion) return;

    const { text: cleanText, imageData: finalImageData } = getDraftPayload();

    if (!cleanText && !finalImageData && !draftQuizAttachment?.chart) {
      setDraftError(
        composerTab === 'pdf'
          ? 'ارفع ملف PDF وحدد الصفحة المطلوب إظهارها للطلاب أولاً'
          : composerTab === 'quizzes'
          ? 'اختر سؤالاً من الاختبارات بالأسفل واضغط «إدراج للجميع الآن» أو «تحميل للتعديل»'
          : 'اكتب نص السؤال، أو ارفع صورة أو صفحة PDF، أو ارسمه على سبورتك الخاصة قبل الإدراج'
      );
      return;
    }

    await publishQuestionToRoom({
      text: cleanText,
      imageData: finalImageData,
      choices:
        includeQuizChoices && draftQuizAttachment?.choices?.length
          ? draftQuizAttachment.choices
          : undefined,
      chart: draftQuizAttachment?.chart,
      sourceQuizTitle: draftQuizAttachment?.answerMeta?.sourceQuizTitle,
      answerMeta: draftQuizAttachment?.answerMeta,
    });
  };

  const handleInsertQuizQuestionDirect = async (qq: QuizQuestion, entry: RoomQuizEntry) => {
    const answerText =
      qq.correctIndex >= 0 && qq.choices[qq.correctIndex]
        ? qq.choices[qq.correctIndex]
        : qq.answer || '';
    await publishQuestionToRoom({
      text: qq.text.slice(0, 2000),
      imageData: '',
      choices: includeQuizChoices && qq.choices?.length ? qq.choices : undefined,
      chart: qq.chart,
      sourceQuizTitle: entry.quiz.title,
      answerMeta: {
        choices: qq.choices || [],
        correctIndex: qq.correctIndex,
        answer: answerText,
        explanation: qq.explanation || '',
        sourceQuizTitle: entry.quiz.title,
      },
    });
  };

  const handleLoadQuizQuestionToDraft = (qq: QuizQuestion, entry: RoomQuizEntry) => {
    const answerText =
      qq.correctIndex >= 0 && qq.choices[qq.correctIndex]
        ? qq.choices[qq.correctIndex]
        : qq.answer || '';
    setDraftText(qq.text.slice(0, 2000));
    setDraftImage('');
    setDraftQuizAttachment({
      choices: qq.choices,
      chart: qq.chart,
      answerMeta: {
        choices: qq.choices || [],
        correctIndex: qq.correctIndex,
        answer: answerText,
        explanation: qq.explanation || '',
        sourceQuizTitle: entry.quiz.title,
      },
    });
    setComposerTab('text');
    setDraftError(null);
    playDuoSound('pop');
  };

  // Supervisor: toggle between Quiz Mode and Explain Mode (defaults to 'all' so students can write alongside the supervisor)
  const handleToggleExplainMode = async (nextMode: 'quiz' | 'explain') => {
    if (!isSupervisor || explainBusy) return;
    setExplainBusy(true);
    try {
      await updateDoc(doc(db, 'rooms', room.id), {
        mode: nextMode,
        explainPresenterId: nextMode === 'explain' ? 'all' : profile.uid,
        explainPresenterName:
          nextMode === 'explain' ? 'الجميع (المشرف والطلاب)' : profile.fullNameQuad,
        updatedAt: serverTimestamp(),
      });
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.id}`);
    } finally {
      setExplainBusy(false);
    }
  };

  const explainBlockedIds = room.explainBlockedIds ?? [];

  // Supervisor: assign who draws on the shared explain board ('all', supervisor UID, or a specific student UID)
  const handleSelectPresenter = async (presenterId: string, presenterName: string) => {
    if (!isSupervisor || explainBusy) return;
    setExplainBusy(true);
    try {
      const nextBlocked = explainBlockedIds.filter((id) => id !== presenterId);
      await updateDoc(doc(db, 'rooms', room.id), {
        mode: 'explain',
        explainPresenterId: presenterId,
        explainPresenterName: presenterName,
        explainBlockedIds: nextBlocked,
        updatedAt: serverTimestamp(),
      });
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.id}`);
    } finally {
      setExplainBusy(false);
    }
  };

  // Supervisor: block or allow a specific student from writing in Explain Mode
  const handleToggleBlockStudent = async (studentId: string) => {
    if (!isSupervisor || explainBusy) return;
    setExplainBusy(true);
    const currentlyBlocked = explainBlockedIds.includes(studentId);
    const nextBlocked = currentlyBlocked
      ? explainBlockedIds.filter((id) => id !== studentId)
      : Array.from(new Set([...explainBlockedIds, studentId]));

    try {
      if (!currentlyBlocked && room.explainPresenterId === studentId) {
        await updateDoc(doc(db, 'rooms', room.id), {
          mode: 'explain',
          explainPresenterId: 'all',
          explainPresenterName: 'الجميع (المشرف والطلاب)',
          explainBlockedIds: nextBlocked,
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(doc(db, 'rooms', room.id), {
          explainBlockedIds: nextBlocked,
          updatedAt: serverTimestamp(),
        });
      }
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.id}`);
    } finally {
      setExplainBusy(false);
    }
  };

  // Collaborative per-user layer sync in Explain Mode (works for blank board OR active PDF/image slide)
  const handleExplainLayerStrokesChange = async (nextStrokes: Stroke[]) => {
    const isBlocked = !isSupervisor && explainBlockedIds.includes(profile.uid);
    const canDraw =
      isSupervisor ||
      (room.mode === 'explain' &&
        !isBlocked &&
        (room.explainPresenterId === 'all' ||
          room.explainPresenterId === profile.uid ||
          !room.explainPresenterId));
    if (!canDraw) return;

    lastExplainEditAtRef.current = Date.now();

    if (activeExplainSlide) {
      setLocalSlideExplainStrokes(nextStrokes);
      const slideId = activeExplainSlide.id;
      const layerPath = `rooms/${room.id}/slides/${slideId}/layers/${profile.uid}`;
      const layerRef = doc(db, 'rooms', room.id, 'slides', slideId, 'layers', profile.uid);
      const existingMine = explainSlideLayers.find((l) => l.authorId === profile.uid);

      try {
        if (!existingMine) {
          await setDoc(layerRef, {
            id: profile.uid,
            roomId: room.id,
            slideId,
            authorId: profile.uid,
            authorName: profile.fullNameQuad,
            strokes: nextStrokes,
            updatedAt: serverTimestamp(),
          });
        } else {
          await updateDoc(layerRef, {
            strokes: nextStrokes,
            updatedAt: serverTimestamp(),
          });
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, layerPath);
      }
      return;
    }

    setLocalExplainStrokes(nextStrokes);
    const layerPath = `rooms/${room.id}/explainLayers/${profile.uid}`;
    const layerRef = doc(db, 'rooms', room.id, 'explainLayers', profile.uid);
    const existingMine = explainLayers.find((l) => l.id === profile.uid);

    try {
      if (!existingMine) {
        await setDoc(layerRef, {
          id: profile.uid,
          roomId: room.id,
          authorId: profile.uid,
          authorName: profile.fullNameQuad,
          strokes: nextStrokes,
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(layerRef, {
          strokes: nextStrokes,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, layerPath);
    }
  };

  // Supervisor: direct Eraser tool sweep erases ANY student's strokes on contact
  const handleSupervisorEraserSweep = async (eraserStroke: Stroke) => {
    if (!isSupervisor || !eraserStroke.isEraser) return;
    const hitRadius = Math.max(eraserStroke.width * 2.4, 24) / 2 + 8;

    try {
      const batch = writeBatch(db);
      let mutations = 0;

      if (activeExplainSlide) {
        for (const layer of explainSlideLayers) {
          if (layer.authorId === profile.uid || !layer.strokes?.length) continue;
          const kept = layer.strokes.filter(
            (s) => !doesStrokeIntersectEraser(eraserStroke.pts, s.pts, hitRadius)
          );
          if (kept.length !== layer.strokes.length) {
            batch.update(
              doc(
                db,
                'rooms',
                room.id,
                'slides',
                activeExplainSlide.id,
                'layers',
                layer.id
              ),
              {
                strokes: kept,
                updatedAt: serverTimestamp(),
              }
            );
            mutations++;
          }
        }
      } else {
        for (const layer of explainLayers) {
          if (layer.id === profile.uid || !layer.strokes?.length) continue;
          const kept = layer.strokes.filter(
            (s) => !doesStrokeIntersectEraser(eraserStroke.pts, s.pts, hitRadius)
          );
          if (kept.length !== layer.strokes.length) {
            batch.update(doc(db, 'rooms', room.id, 'explainLayers', layer.id), {
              strokes: kept,
              updatedAt: serverTimestamp(),
            });
            mutations++;
          }
        }
        if (sharedBoardExists && sharedStrokes.length > 0) {
          const keptShared = sharedStrokes.filter(
            (s) => !doesStrokeIntersectEraser(eraserStroke.pts, s.pts, hitRadius)
          );
          if (keptShared.length !== sharedStrokes.length) {
            batch.update(doc(db, 'rooms', room.id, 'sharedBoard', 'live'), {
              strokes: keptShared,
              updatedBy: profile.uid,
              updatedByName: profile.fullNameQuad,
              updatedAt: serverTimestamp(),
            });
            mutations++;
          }
        }
      }

      if (mutations > 0) {
        await batch.commit();
      }
    } catch (err) {
      console.error('Supervisor eraser sweep error:', err);
    }
  };

  // Supervisor: clear a specific person's writing (student or supervisor) on the active Explain board
  const handleClearPersonExplain = async (targetUid: string) => {
    if (!isSupervisor || explainBusy) return;
    setExplainBusy(true);
    try {
      if (activeExplainSlide) {
        if (targetUid === profile.uid) {
          lastExplainEditAtRef.current = 0;
          setLocalSlideExplainStrokes([]);
        }
        const targetLayer = explainSlideLayers.find((l) => l.authorId === targetUid);
        if (targetLayer) {
          await deleteDoc(
            doc(
              db,
              'rooms',
              room.id,
              'slides',
              activeExplainSlide.id,
              'layers',
              targetLayer.id
            )
          );
        }
      } else {
        if (targetUid === profile.uid) {
          lastExplainEditAtRef.current = 0;
          setLocalExplainStrokes([]);
        }
        const targetLayer = explainLayers.find((l) => l.id === targetUid);
        if (targetLayer) {
          await deleteDoc(doc(db, 'rooms', room.id, 'explainLayers', targetLayer.id));
        }
      }
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `rooms/${room.id}/explainLayers`);
    } finally {
      setExplainBusy(false);
    }
  };

  // Supervisor: clear everyone's strokes on the currently active Explain board/page
  const handleClearAllExplainBoard = async () => {
    if (!isSupervisor || explainBusy) return;
    setExplainBusy(true);
    lastExplainEditAtRef.current = 0;
    try {
      const batch = writeBatch(db);
      if (activeExplainSlide) {
        setLocalSlideExplainStrokes([]);
        for (const layer of explainSlideLayers) {
          batch.delete(
            doc(
              db,
              'rooms',
              room.id,
              'slides',
              activeExplainSlide.id,
              'layers',
              layer.id
            )
          );
        }
      } else {
        setLocalExplainStrokes([]);
        for (const layer of explainLayers) {
          batch.delete(doc(db, 'rooms', room.id, 'explainLayers', layer.id));
        }
        if (sharedBoardExists) {
          batch.update(doc(db, 'rooms', room.id, 'sharedBoard', 'live'), {
            strokes: [],
            updatedBy: profile.uid,
            updatedByName: profile.fullNameQuad,
            updatedAt: serverTimestamp(),
          });
        }
      }
      await batch.commit();
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `rooms/${room.id}/explainLayers`);
    } finally {
      setExplainBusy(false);
    }
  };

  // Supervisor: upload Image or PDF onto the Explain Mode whiteboard
  const handleExplainFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !isSupervisor) return;

    setExplainUploadError(null);
    setExplainUploading(true);
    const shouldAppend = explainAppendModeRef.current && explainSlides.length > 0;

    try {
      let newImages: string[] = [];
      const isPdf =
        file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

      if (isPdf) {
        setExplainUploadStatus('جاري قراءة صفحات ملف PDF...');
        newImages = await renderPdfToSlideImages(
          file,
          (done, total) => {
            setExplainUploadStatus(`جاري تجهيز الصفحة ${done} من ${total}...`);
          },
          25
        );
      } else if (file.type.startsWith('image/')) {
        setExplainUploadStatus('جاري تجهيز الصورة للسبورة...');
        const imgUrl = await compressSlideImageToDataUrl(file);
        newImages = [imgUrl];
      } else {
        setExplainUploadError('يرجى اختيار صورة (PNG / JPG) أو ملف PDF صالح');
        setExplainUploading(false);
        return;
      }

      if (newImages.length === 0) {
        setExplainUploadError('لم يتم العثور على صفحات قابلة للعرض في الملف');
        setExplainUploading(false);
        return;
      }

      const maxAllowed = shouldAppend ? Math.max(0, 100 - explainSlides.length) : 100;
      const slicedImages = newImages.slice(0, maxAllowed);
      if (slicedImages.length === 0) {
        setExplainUploadError('تم الوصول للحد الأقصى (100 صفحة)');
        setExplainUploading(false);
        return;
      }

      if (!shouldAppend && explainSlides.length > 0) {
        setExplainUploadStatus('جاري استبدال الشرائح السابقة...');
        for (const oldSlide of explainSlides) {
          const oldLayersSnap = await getDocs(
            query(
              collection(db, 'rooms', room.id, 'slides', oldSlide.id, 'layers'),
              where('roomId', '==', room.id),
              where('slideId', '==', oldSlide.id)
            )
          );
          const delBatch = writeBatch(db);
          oldLayersSnap.forEach((d) => delBatch.delete(d.ref));
          delBatch.delete(doc(db, 'rooms', room.id, 'slides', oldSlide.id));
          await delBatch.commit();
        }
      }

      const startIndex = shouldAppend
        ? Math.max(...explainSlides.map((s) => s.pageIndex), 0) + 1
        : 1;
      const batchStamp = Date.now();
      const CHUNK_SIZE = 5;

      for (let i = 0; i < slicedImages.length; i += CHUNK_SIZE) {
        const chunk = slicedImages.slice(i, i + CHUNK_SIZE);
        setExplainUploadStatus(
          `جاري رفع الصفحات (${Math.min(i + chunk.length, slicedImages.length)} / ${slicedImages.length})...`
        );
        const batch = writeBatch(db);
        chunk.forEach((imgData, offset) => {
          const pageIndex = startIndex + i + offset;
          const slideId = `ex_${batchStamp}_${pageIndex}`;
          batch.set(doc(db, 'rooms', room.id, 'slides', slideId), {
            id: slideId,
            roomId: room.id,
            pageIndex,
            imageData: imgData,
            createdAt: serverTimestamp(),
          });
        });
        await batch.commit();
      }

      const nextCount = shouldAppend
        ? explainSlides.length + slicedImages.length
        : slicedImages.length;
      const targetPage = shouldAppend ? startIndex : 1;

      await updateDoc(doc(db, 'rooms', room.id), {
        currentSlideIndex: targetPage,
        slideCount: nextCount,
        updatedAt: serverTimestamp(),
      });
      playDuoSound('correct');
    } catch (err) {
      console.error(err);
      setExplainUploadError('تعذر رفع الصورة أو ملف PDF، يرجى المحاولة مرة أخرى');
    } finally {
      setExplainUploading(false);
      setExplainUploadStatus('');
    }
  };

  const handleExplainGoToPage = async (targetPage: number) => {
    if (!isSupervisor || explainBusy) return;
    const clamped =
      targetPage <= 0 ? 0 : Math.max(1, Math.min(explainSlides.length, targetPage));
    try {
      await updateDoc(doc(db, 'rooms', room.id), {
        currentSlideIndex: clamped,
        slideCount: explainSlides.length,
        updatedAt: serverTimestamp(),
      });
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.id}`);
    }
  };

  const handleRemoveExplainSlides = async () => {
    if (!isSupervisor || explainUploading || explainSlides.length === 0) return;
    setExplainUploading(true);
    setExplainUploadStatus('جاري إزالة صفحات الشرح والعودة للسبورة البيضاء...');
    try {
      for (const oldSlide of explainSlides) {
        const oldLayersSnap = await getDocs(
          query(
            collection(db, 'rooms', room.id, 'slides', oldSlide.id, 'layers'),
            where('roomId', '==', room.id),
            where('slideId', '==', oldSlide.id)
          )
        );
        const delBatch = writeBatch(db);
        oldLayersSnap.forEach((d) => delBatch.delete(d.ref));
        delBatch.delete(doc(db, 'rooms', room.id, 'slides', oldSlide.id));
        await delBatch.commit();
      }
      await updateDoc(doc(db, 'rooms', room.id), {
        currentSlideIndex: 0,
        slideCount: 0,
        updatedAt: serverTimestamp(),
      });
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `rooms/${room.id}/slides`);
    } finally {
      setExplainUploading(false);
      setExplainUploadStatus('');
    }
  };

  // Student: save board strokes live
  const syncStudentBoard = async (strokes: Stroke[], submitted: boolean) => {
    if (!currentQuestion || isSupervisor) return;
    const boardRef = doc(
      db,
      'rooms',
      room.id,
      'questions',
      currentQuestion.id,
      'boards',
      profile.uid
    );
    const bPath = `rooms/${room.id}/questions/${currentQuestion.id}/boards/${profile.uid}`;

    try {
      if (!myBoard) {
        await setDoc(boardRef, {
          studentId: profile.uid,
          studentName: profile.fullNameQuad,
          roomId: room.id,
          questionId: currentQuestion.id,
          strokes,
          submitted,
          verdict: 'pending',
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(boardRef, {
          strokes,
          submitted,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, bPath);
    }
  };

  const handleStrokesChange = (next: Stroke[]) => {
    if (isTimeUp) return;
    setLocalStrokes(next);
    if (!currentQuestion || currentQuestion.status !== 'solving') return;
    if (myBoard?.submitted || myBoard?.verdict === 'wrong') return;
    void syncStudentBoard(next, false);
  };

  const handleStudentSubmit = async () => {
    if (!currentQuestion || submittingBoard || isSupervisor || isTimeUp) return;
    setSubmittingBoard(true);
    try {
      await syncStudentBoard(localStrokes, true);
      playDuoSound('pop');
    } finally {
      setSubmittingBoard(false);
    }
  };

  // Supervisor: grade submitted board ("صح" or "غلط")
  const handleGradeBoard = async (board: StudentBoard, isCorrect: boolean) => {
    if (!currentQuestion || !isSupervisor || gradingBusy) return;
    setGradingBusy(true);

    try {
      const batch = writeBatch(db);
      const boardRef = doc(
        db,
        'rooms',
        room.id,
        'questions',
        currentQuestion.id,
        'boards',
        board.studentId
      );
      const qRef = doc(db, 'rooms', room.id, 'questions', currentQuestion.id);

      if (isCorrect) {
        batch.update(boardRef, {
          verdict: 'correct',
          updatedAt: serverTimestamp(),
        });
        batch.update(qRef, {
          status: 'correct',
          winnerId: board.studentId,
          winnerName: board.studentName,
          updatedAt: serverTimestamp(),
        });
        const targetPart = participants.find((p) => p.uid === board.studentId);
        if (targetPart) {
          batch.update(doc(db, 'rooms', room.id, 'participants', board.studentId), {
            score: (targetPart.score || 0) + 100,
            correctCount: (targetPart.correctCount || 0) + 1,
            updatedAt: serverTimestamp(),
          });
        }
        playDuoSound('correct');
      } else {
        batch.update(boardRef, {
          verdict: 'wrong',
          updatedAt: serverTimestamp(),
        });

        const nextWrongIds = Array.from(
          new Set([...(currentQuestion.wrongStudentIds || []), board.studentId])
        ).slice(0, 2);
        const nextAttempts = Math.min(2, (currentQuestion.attemptsUsed || 0) + 1);

        // If 1st student got it wrong AND there are at least 2 students in the room -> pass to 2nd student!
        const hasSecondStudent = participants.length >= 2 && nextAttempts === 1;

        if (hasSecondStudent) {
          batch.update(qRef, {
            attemptsUsed: 1,
            wrongStudentIds: nextWrongIds,
            updatedAt: serverTimestamp(),
          });
        } else {
          // 2nd student also got it wrong (or only 1 student) -> no one gets the point
          batch.update(qRef, {
            status: 'unanswered',
            attemptsUsed: nextAttempts,
            wrongStudentIds: nextWrongIds,
            updatedAt: serverTimestamp(),
          });
        }
        playDuoSound('wrong');
      }

      await batch.commit();
    } catch (err) {
      handleFirestoreError(
        err,
        OperationType.WRITE,
        `rooms/${room.id}/questions/${currentQuestion.id}`
      );
    } finally {
      setGradingBusy(false);
    }
  };

  // Supervisor: skip / close current question manually
  const handleCloseQuestionUnanswered = async () => {
    if (!currentQuestion || !isSupervisor || currentQuestion.status !== 'solving') return;
    setGradingBusy(true);
    try {
      await updateDoc(doc(db, 'rooms', room.id, 'questions', currentQuestion.id), {
        status: 'unanswered',
        attemptsUsed: currentQuestion.attemptsUsed || 0,
        wrongStudentIds: currentQuestion.wrongStudentIds || [],
        updatedAt: serverTimestamp(),
      });
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(
        err,
        OperationType.UPDATE,
        `rooms/${room.id}/questions/${currentQuestion.id}`
      );
    } finally {
      setGradingBusy(false);
    }
  };

  // Supervisor: finish the whole test
  const handleFinishRoom = async () => {
    if (!isSupervisor || finishingRoom) return;
    setFinishingRoom(true);
    try {
      await updateDoc(doc(db, 'rooms', room.id), {
        status: 'finished',
        updatedAt: serverTimestamp(),
      });
      playDuoSound('finish');
      setShowEndConfirm(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.id}`);
    } finally {
      setFinishingRoom(false);
    }
  };

  // Determine student lock state
  const studentLockedInfo = useMemo(() => {
    if (!currentQuestion) {
      return {
        locked: true,
        title: 'السبورة مقفلة حالياً',
        subtitle: 'بانتظار المشرف لكتابة السؤال أو رفع الصورة والضغط على «أدرج السؤال»',
      };
    }
    if (currentQuestion.status === 'correct') {
      return {
        locked: true,
        title: `انتهى السؤال — أُحتسبت الإجابة للطالب ${currentQuestion.winnerName}`,
        subtitle: 'بانتظار المشرف لإدراج السؤال التالي أو إنهاء الاختبار',
      };
    }
    if (currentQuestion.status === 'unanswered') {
      return {
        locked: true,
        title: 'انتهت المحاولات — لم تُحسب الإجابة لأحد',
        subtitle: 'بانتظار المشرف لإدراج السؤال التالي أو إنهاء الاختبار',
      };
    }
    if (
      currentQuestion.wrongStudentIds?.includes(profile.uid) ||
      myBoard?.verdict === 'wrong'
    ) {
      return {
        locked: true,
        title: 'إجابتك غير صحيحة',
        subtitle: 'تحوّل السؤال إلى الطالب الثاني للمحاولة الأخيرة',
      };
    }
    if (myBoard?.submitted) {
      return {
        locked: true,
        title: 'تم تسليم إجابتك للمشرف',
        subtitle: 'بانتظار تأكيد المشرف على صحة الإجابة',
      };
    }
    if (isTimeUp) {
      return {
        locked: true,
        title: 'انتهى وقت السؤال!',
        subtitle: 'انتهت المهلة المحددة لهذا السؤال — بانتظار المشرف لإنهائه أو إدراج السؤال التالي',
      };
    }
    return { locked: false, title: '', subtitle: '' };
  }, [currentQuestion, myBoard?.submitted, myBoard?.verdict, profile.uid, isTimeUp]);

  useEffect(() => {
    if (studentLockedInfo.locked) {
      setStudentFullscreen(false);
    }
  }, [studentLockedInfo.locked, currentQuestion?.id]);

  const isExplainMode = room.mode === 'explain';
  const isAmIBlockedInExplain = !isSupervisor && explainBlockedIds.includes(profile.uid);
  const isExplainOpenToAll =
    room.explainPresenterId === 'all' || !room.explainPresenterId;
  const canDrawOnSharedBoard =
    isSupervisor ||
    (isExplainMode &&
      !isAmIBlockedInExplain &&
      (isExplainOpenToAll || room.explainPresenterId === profile.uid));
  const currentPresenterName = isExplainOpenToAll
    ? 'الجميع (المشرف والطلاب معاً)'
    : room.explainPresenterName || room.supervisorName;

  const activeExplainMineStrokes = activeExplainSlide
    ? localSlideExplainStrokes
    : localExplainStrokes;

  const otherExplainOverlayLayers = useMemo(() => {
    if (activeExplainSlide) {
      return explainSlideLayers
        .filter((l) => l.authorId !== profile.uid && (l.strokes?.length ?? 0) > 0)
        .map((l) => l.strokes);
    }
    const layers = explainLayers
      .filter((l) => l.id !== profile.uid && (l.strokes?.length ?? 0) > 0)
      .map((l) => l.strokes);
    if (sharedStrokes.length > 0) {
      layers.unshift(sharedStrokes);
    }
    return layers;
  }, [activeExplainSlide, explainSlideLayers, explainLayers, profile.uid, sharedStrokes]);

  const activeExplainLayerWriters = useMemo(() => {
    const map = new Map<string, number>();
    if (activeExplainSlide) {
      for (const l of explainSlideLayers) {
        if ((l.strokes?.length ?? 0) > 0) {
          map.set(l.authorId, l.strokes.length);
        }
      }
    } else {
      for (const l of explainLayers) {
        if ((l.strokes?.length ?? 0) > 0) {
          map.set(l.authorId, l.strokes.length);
        }
      }
    }
    return map;
  }, [activeExplainSlide, explainSlideLayers, explainLayers]);

  const hasAnyExplainStrokes = activeExplainSlide
    ? localSlideExplainStrokes.length > 0 ||
      explainSlideLayers.some((l) => (l.strokes?.length ?? 0) > 0)
    : localExplainStrokes.length > 0 ||
      sharedStrokes.length > 0 ||
      explainLayers.some((l) => (l.strokes?.length ?? 0) > 0);

  const myParticipant = participants.find((p) => p.uid === profile.uid);
  const progressPercent = currentQuestion
    ? currentQuestion.status === 'solving'
      ? 65
      : 100
    : 15;

  return (
    <div className="max-w-7xl mx-auto px-2.5 sm:px-6 py-4 sm:py-5 flex flex-col gap-4 sm:gap-5">
      {/* Arena Top Strip */}
      <div className="duo-card p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4 flex-1 min-w-[220px]">
          <div className="flex flex-col">
            <span className="text-xs font-extrabold text-[#777777]">
              رمز الغرفة:{' '}
              <span className="font-latin text-[#1CB0F6] font-black">{room.id}</span>
            </span>
            <span className="text-base font-black text-[#3C3C3C]">
              {isExplainMode
                ? 'وضع الشرح التفاعلي المباشر'
                : currentQuestion
                ? `السؤال رقم ${currentQuestion.orderIndex}`
                : 'بانتظار إدراج السؤال الأول'}
            </span>
          </div>

          {/* Iconic Duolingo Glossy Progress Bar */}
          <div className="hidden sm:block flex-1 max-w-md h-4 bg-[#E5E5E5] rounded-full overflow-hidden">
            <div
              className={`duo-progress-fill h-full rounded-full ${
                isExplainMode ? 'bg-[#1CB0F6]' : 'bg-[#58CC02]'
              }`}
              style={{ width: isExplainMode ? '100%' : `${progressPercent}%` }}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {!isSupervisor && (
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#DDF4FF] border-2 border-[#1CB0F6]">
              <DuoGemIcon className="w-5 h-5" />
              <span className="font-latin text-base font-black text-[#1899D6]">
                {myParticipant?.score ?? 0}
              </span>
              <span className="text-xs font-extrabold text-[#1899D6]">نقطة</span>
            </div>
          )}

          {isSupervisor && (
            <>
              {isExplainMode ? (
                <button
                  type="button"
                  disabled={explainBusy}
                  onClick={() => handleToggleExplainMode('quiz')}
                  className="duo-btn flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-[#46A302] border-b-4 text-white text-sm font-black cursor-pointer whitespace-nowrap disabled:opacity-60"
                >
                  <ArrowRight className="w-4 h-4" />
                  <span>العودة لوضع الأسئلة</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={explainBusy}
                  onClick={() => handleToggleExplainMode('explain')}
                  className="duo-btn flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-[#1899D6] border-b-4 text-white text-sm font-black cursor-pointer whitespace-nowrap disabled:opacity-60"
                >
                  <Presentation className="w-4 h-4" />
                  <span>شرح (سبورة جماعية)</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setShowEndConfirm(true)}
                className="duo-btn flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#FF4B4B] hover:bg-[#FF6161] border-2 border-[#EA2B2B] border-b-4 text-white text-sm font-black cursor-pointer whitespace-nowrap"
              >
                <Flag className="w-4 h-4" />
                <span>إنهاء الاختبار</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* ==================== EXPLAIN MODE (SHARED SYNCHRONIZED BOARD) ==================== */}
      {isExplainMode ? (
        <div className="flex flex-col gap-4 sm:gap-5">
          {/* Hidden Upload Input for Supervisor (Image or PDF) */}
          {isSupervisor && (
            <input
              ref={explainFileInputRef}
              type="file"
              accept="application/pdf,image/*"
              onChange={handleExplainFileSelected}
              className="hidden"
            />
          )}

          {/* Explain Mode Status, PDF/Image Controls & Per-Student Permissions Card */}
          <div className="duo-card p-4 sm:p-6 bg-[#DDF4FF]/45 border-[#1CB0F6] flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-2xl bg-[#1CB0F6] text-white flex items-center justify-center shrink-0">
                  <Presentation className="w-6 h-6" />
                </div>
                <div>
                  <span className="text-xs font-extrabold text-[#1899D6] block">
                    صبورة الشرح التفاعلية المتزامنة للجميع
                  </span>
                  <h2 className="text-lg sm:text-xl font-black text-[#3C3C3C]">
                    يشرح الآن: {currentPresenterName}
                  </h2>
                </div>
              </div>

              {!isSupervisor && (
                isAmIBlockedInExplain ? (
                  <span className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-[#EA2B2B] text-xs sm:text-sm font-black">
                    <Lock className="w-4 h-4 shrink-0" />
                    <span>أوقف المشرف الكتابة عنك مؤقتاً — يمكنك المشاهدة والتكبير</span>
                  </span>
                ) : canDrawOnSharedBoard ? (
                  <span className="px-4 py-2 rounded-xl bg-[#D7FFB8] border-2 border-[#58CC02] text-[#46A302] text-xs sm:text-sm font-black">
                    {isExplainOpenToAll
                      ? 'السبورة مفتوحة للجميع — يمكنك الكتابة والرسم مع المشرف والطلاب!'
                      : 'أنت تملك القلم الآن — ارسم وسيظهر شرحك للجميع'}
                  </span>
                ) : (
                  <span className="px-4 py-2 rounded-xl bg-white border-2 border-[#E5E5E5] text-[#777777] text-xs sm:text-sm font-black">
                    الكتابة مقتصرة حالياً على {currentPresenterName}
                  </span>
                )
              )}

              {isSupervisor && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={explainUploading}
                    onClick={() => {
                      explainAppendModeRef.current = false;
                      explainFileInputRef.current?.click();
                    }}
                    className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#FFC800] hover:bg-[#FFD324] border-2 border-b-4 border-[#E5A400] text-xs font-black text-[#3C3C3C] cursor-pointer disabled:opacity-60"
                  >
                    <Upload className="w-4 h-4" />
                    <span>
                      {explainSlides.length > 0 ? 'تغيير الصورة / PDF' : 'رفع صورة أو PDF'}
                    </span>
                  </button>

                  {explainSlides.length > 0 && (
                    <button
                      type="button"
                      disabled={explainUploading}
                      onClick={() => {
                        explainAppendModeRef.current = true;
                        explainFileInputRef.current?.click();
                      }}
                      className="duo-btn flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border-2 border-b-4 border-[#1CB0F6] text-xs font-black text-[#1899D6] hover:bg-[#DDF4FF] cursor-pointer disabled:opacity-60"
                    >
                      <FilePlus2 className="w-4 h-4" />
                      <span>إضافة صفحات</span>
                    </button>
                  )}

                  {hasAnyExplainStrokes && (
                    <button
                      type="button"
                      disabled={explainBusy}
                      onClick={() => void handleClearAllExplainBoard()}
                      className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs font-black text-[#EA2B2B] hover:bg-[#FFDFE0] cursor-pointer disabled:opacity-60"
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>مسح السبورة للجميع</span>
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Supervisor Upload Progress / Error */}
            {explainUploading && (
              <div className="p-3 rounded-xl bg-[#FFF4CC] border-2 border-[#FFC800] text-xs sm:text-sm font-black text-[#9A6B00] flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span>{explainUploadStatus || 'جاري تجهيز الملف...'}</span>
              </div>
            )}
            {explainUploadError && (
              <div className="p-3 rounded-xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-xs sm:text-sm font-extrabold text-[#EA2B2B]">
                {explainUploadError}
              </div>
            )}

            {/* Uploaded Image / PDF Page Navigation Strip in Explain Mode */}
            {explainSlides.length > 0 && (
              <div className="pt-3 border-t-2 border-[#BCE8FF] flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-black text-[#1899D6]">
                    <FileText className="w-4 h-4" />
                    <span>
                      {activeExplainSlide
                        ? `صفحة ${activeExplainSlide.pageIndex} من ${explainSlides.length}`
                        : `السبورة البيضاء (${explainSlides.length} صفحة محفوظة)`}
                    </span>
                  </span>

                  {isSupervisor && (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={!activeExplainSlide || activeExplainSlide.pageIndex <= 1}
                        onClick={() =>
                          void handleExplainGoToPage((activeExplainSlide?.pageIndex ?? 2) - 1)
                        }
                        className="duo-btn flex items-center gap-1 px-2.5 py-1 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer disabled:opacity-40"
                      >
                        <ChevronRight className="w-3.5 h-3.5" />
                        <span>السابقة</span>
                      </button>
                      <button
                        type="button"
                        disabled={
                          explainSlideIndex >= explainSlides.length
                        }
                        onClick={() =>
                          void handleExplainGoToPage(
                            activeExplainSlide ? activeExplainSlide.pageIndex + 1 : 1
                          )
                        }
                        className="duo-btn flex items-center gap-1 px-2.5 py-1 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer disabled:opacity-40"
                      >
                        <span>التالية</span>
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                {isSupervisor && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void handleExplainGoToPage(0)}
                      className={`duo-btn px-2.5 py-1 rounded-xl border-2 text-xs font-black cursor-pointer ${
                        explainSlideIndex === 0
                          ? 'bg-[#58CC02] border-[#46A302] text-white'
                          : 'bg-white border-[#E5E5E5] text-[#3C3C3C]'
                      }`}
                    >
                      سبورة بيضاء
                    </button>

                    <div className="flex items-center gap-1 overflow-x-auto max-w-full">
                      {explainSlides.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => void handleExplainGoToPage(s.pageIndex)}
                          className={`font-latin min-w-[28px] h-7 px-2 rounded-lg text-xs font-black cursor-pointer shrink-0 ${
                            explainSlideIndex === s.pageIndex
                              ? 'bg-[#1CB0F6] text-white border-2 border-[#1899D6]'
                              : 'bg-white text-[#777777] border border-[#E5E5E5] hover:text-[#3C3C3C]'
                          }`}
                        >
                          {s.pageIndex}
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      disabled={explainUploading}
                      onClick={() => void handleRemoveExplainSlides()}
                      className="duo-btn px-2.5 py-1 rounded-xl bg-white border-2 border-[#E5E5E5] text-xs font-black text-[#EA2B2B] hover:bg-[#FFDFE0] cursor-pointer"
                      title="إزالة الصور والملف بالكامل"
                    >
                      إزالة الملف
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Supervisor Global & Per-Person Controls (Allow/Block writing + Erase anyone's strokes) */}
            {isSupervisor && (
              <div className="pt-3 border-t-2 border-[#BCE8FF] flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-extrabold text-[#1899D6]">
                    <Users className="w-4 h-4" />
                    <span>التحكم بالكتابة والمسح لكل شخص (أو استخدم المسّاحة مباشرة على خط أي طالب):</span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      disabled={explainBusy}
                      onClick={() =>
                        handleSelectPresenter('all', 'الجميع (المشرف والطلاب)')
                      }
                      className={`duo-btn px-3.5 py-1.5 rounded-xl border-2 border-b-3 text-xs font-black cursor-pointer whitespace-nowrap ${
                        isExplainOpenToAll
                          ? 'bg-[#58CC02] border-[#46A302] text-white'
                          : 'bg-white border-[#E5E5E5] text-[#3C3C3C] hover:bg-[#F7F7F7]'
                      }`}
                    >
                      الجميع يكتب
                    </button>

                    <button
                      type="button"
                      disabled={explainBusy}
                      onClick={() => handleSelectPresenter(profile.uid, profile.fullNameQuad)}
                      className={`duo-btn px-3.5 py-1.5 rounded-xl border-2 border-b-3 text-xs font-black cursor-pointer whitespace-nowrap ${
                        room.explainPresenterId === profile.uid
                          ? 'bg-[#1CB0F6] border-[#1899D6] text-white'
                          : 'bg-white border-[#E5E5E5] text-[#3C3C3C] hover:bg-[#F7F7F7]'
                      }`}
                    >
                      المشرف فقط يكتب
                    </button>

                    {activeExplainLayerWriters.has(profile.uid) && (
                      <button
                        type="button"
                        disabled={explainBusy}
                        onClick={() => void handleClearPersonExplain(profile.uid)}
                        className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#EA2B2B] hover:bg-[#FFDFE0] cursor-pointer"
                      >
                        <Eraser className="w-3.5 h-3.5" />
                        <span>مسح خط المشرف</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Per-Student Rows: Block/Allow Writing, Exclusive Pen, and Erase Specific Person's Writing */}
                {participants.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {participants.map((p) => {
                      const isExclusive = room.explainPresenterId === p.uid;
                      const isBlocked = explainBlockedIds.includes(p.uid);
                      const strokeCount = activeExplainLayerWriters.get(p.uid) ?? 0;

                      return (
                        <div
                          key={p.uid}
                          className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-xl border-2 bg-white ${
                            isBlocked
                              ? 'border-[#FF4B4B]/60 bg-[#FFDFE0]/30'
                              : isExclusive
                              ? 'border-[#FFC800] bg-[#FFF4CC]/35'
                              : 'border-[#E5E5E5]'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-xs sm:text-sm font-black text-[#3C3C3C] truncate max-w-[160px]">
                              {p.fullNameQuad}
                            </span>
                            {strokeCount > 0 && (
                              <span className="font-latin px-2 py-0.5 rounded-lg bg-[#DDF4FF] text-[#1899D6] text-[10px] font-black shrink-0">
                                {strokeCount} خط
                              </span>
                            )}
                            {isBlocked && (
                              <span className="px-2 py-0.5 rounded-lg bg-[#FFDFE0] text-[#EA2B2B] text-[10px] font-black shrink-0">
                                ممنوع من الكتابة
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              disabled={explainBusy}
                              onClick={() => void handleToggleBlockStudent(p.uid)}
                              title={isBlocked ? 'السماح له بالكتابة' : 'منعه من الكتابة'}
                              className={`duo-btn flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-black cursor-pointer ${
                                isBlocked
                                  ? 'bg-[#58CC02] border-[#46A302] text-white'
                                  : 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B] hover:bg-[#FFC7C9]'
                              }`}
                            >
                              {isBlocked ? (
                                <>
                                  <Unlock className="w-3 h-3" />
                                  <span>السماح</span>
                                </>
                              ) : (
                                <>
                                  <Ban className="w-3 h-3" />
                                  <span>منع الكتابة</span>
                                </>
                              )}
                            </button>

                            <button
                              type="button"
                              disabled={explainBusy}
                              onClick={() => handleSelectPresenter(p.uid, p.fullNameQuad)}
                              className={`duo-btn px-2.5 py-1 rounded-lg border text-[11px] font-black cursor-pointer ${
                                isExclusive
                                  ? 'bg-[#FFC800] border-[#E5A400] text-[#3C3C3C]'
                                  : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#3C3C3C] hover:bg-[#FFF4CC]'
                              }`}
                            >
                              {isExclusive ? 'يشرح الآن' : 'القلم له'}
                            </button>

                            <button
                              type="button"
                              disabled={explainBusy || strokeCount === 0}
                              onClick={() => void handleClearPersonExplain(p.uid)}
                              title="مسح كتابة هذا الشخص"
                              className="duo-btn flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[#E5E5E5] bg-white text-[11px] font-black text-[#EA2B2B] hover:bg-[#FFDFE0] cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
                            >
                              <Eraser className="w-3 h-3" />
                              <span>مسح خطه</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Synchronized Explain Whiteboard (Collaborative multi-layer + optional Image/PDF background) */}
          <WhiteboardCanvas
            strokes={activeExplainMineStrokes}
            backgroundImage={activeExplainSlide?.imageData || undefined}
            overlayStrokeLayers={otherExplainOverlayLayers}
            onStrokesChange={(next) => void handleExplainLayerStrokesChange(next)}
            onEraserSweep={
              isSupervisor
                ? (eraserStroke) => void handleSupervisorEraserSweep(eraserStroke)
                : undefined
            }
            viewOnly={!canDrawOnSharedBoard}
            viewOnlyLabel={
              isAmIBlockedInExplain
                ? 'أوقف المشرف الكتابة عنك مؤقتاً — يمكنك المشاهدة والتكبير فقط'
                : 'وضع المشاهدة المباشرة — يمكنك التكبير أو التحريك لمتابعة الشرح'
            }
            syncIntervalMs={600}
            heightClass="h-[320px] sm:h-[460px] md:h-[560px]"
          />
        </div>
      ) : (
        <>

      {/* Active Question Banner (Visible to everyone ONLY after supervisor inserts it) */}
      {currentQuestion ? (
        <div
          className={`duo-card p-5 sm:p-6 flex flex-col gap-4 ${
            currentQuestion.status === 'correct'
              ? 'bg-[#D7FFB8]/45 border-[#58CC02]'
              : currentQuestion.status === 'unanswered'
              ? 'bg-[#FFDFE0]/45 border-[#FF4B4B]'
              : 'bg-white'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="font-latin px-3 py-1 rounded-xl bg-[#1CB0F6] text-white text-sm font-black">
                س{currentQuestion.orderIndex}
              </span>
              {currentQuestion.status === 'solving' && (
                <span className="text-sm font-black text-[#1899D6]">
                  {currentQuestion.attemptsUsed === 0
                    ? 'جاري الحل — أسرع طالب يضغط «تم» أولاً!'
                    : 'أخطأ الطالب الأول — تحوّل السؤال الآن للطالب الثاني!'}
                </span>
              )}
              {currentQuestion.status === 'correct' && (
                <div className="flex items-center gap-2 text-[#46A302]">
                  <DuoCheckBadge className="w-6 h-6" />
                  <span className="text-base font-black">
                    إجابة صحيحة! أُحتسب السؤال للطالب: {currentQuestion.winnerName}
                  </span>
                </div>
              )}
              {currentQuestion.status === 'unanswered' && (
                <div className="flex items-center gap-2 text-[#EA2B2B]">
                  <DuoCrossBadge className="w-6 h-6" />
                  <span className="text-base font-black">
                    انتهت المحاولتان — لم تُحسب الإجابة لأحد
                  </span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {currentQuestion.status === 'solving' && activeTimerTotal > 0 && timerRemainingSeconds !== null && (
                <div
                  className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl border-2 font-black text-sm ${
                    isTimeUp
                      ? 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B]'
                      : timerRemainingSeconds <= 10
                      ? 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B] animate-pulse'
                      : 'bg-[#DDF4FF] border-[#1CB0F6] text-[#1899D6]'
                  }`}
                >
                  <Timer className="w-4 h-4 shrink-0" />
                  <span className="font-latin text-base">
                    {formatTimerClock(timerRemainingSeconds)}
                  </span>
                  <span className="text-xs">
                    {isTimeUp ? 'انتهى الوقت!' : 'الوقت المتبقي'}
                  </span>
                </div>
              )}

              {isSupervisor && (
                <button
                  type="button"
                  disabled={activeAiLoading}
                  onClick={() => void handleAskAiForActiveQuestion()}
                  className={`duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl border-2 border-b-4 text-xs font-black cursor-pointer disabled:opacity-60 ${
                    activeAiOpen
                      ? 'bg-[#CE82FF] border-[#A560E8] text-white'
                      : 'bg-[#F8EDFF] hover:bg-[#F1DCFF] border-[#CE82FF] text-[#8938D6]'
                  }`}
                >
                  {activeAiLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Bot className="w-4 h-4" />
                  )}
                  <span>
                    {activeAiLoading
                      ? 'جاري الحل بالـ AI...'
                      : activeAiOpen && activeAiCache[currentQuestion.id]
                      ? 'إخفاء حل الـ AI'
                      : 'الحل والطريقة بالـ AI'}
                  </span>
                </button>
              )}

              {isSupervisor && currentQuestion.status === 'solving' && (
                <button
                  type="button"
                  disabled={gradingBusy}
                  onClick={handleCloseQuestionUnanswered}
                  className={`duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl border-2 border-b-4 text-xs font-extrabold cursor-pointer ${
                    isTimeUp
                      ? 'bg-[#FF4B4B] hover:bg-[#FF6161] border-[#EA2B2B] text-white'
                      : 'bg-white border-[#E5E5E5] text-[#777777] hover:text-[#3C3C3C]'
                  }`}
                >
                  <SkipForward className="w-4 h-4" />
                  <span>{isTimeUp ? 'إغلاق السؤال وتجهيز التالي' : 'تخطي السؤال'}</span>
                </button>
              )}
            </div>
          </div>

          {currentQuestion.status === 'solving' && activeTimerTotal > 0 && timerRemainingSeconds !== null && (
            <div className="flex flex-col gap-2">
              <div className="w-full h-2.5 rounded-full bg-[#E5E5E5] overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    isTimeUp || timerRemainingSeconds <= 10 ? 'bg-[#FF4B4B]' : 'bg-[#1CB0F6]'
                  }`}
                  style={{
                    width: `${Math.max(
                      0,
                      Math.min(100, (timerRemainingSeconds / activeTimerTotal) * 100)
                    )}%`,
                  }}
                />
              </div>

              {isSupervisor && isTimeUp && (
                <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 rounded-2xl bg-[#FFDFE0]/70 border-2 border-[#FF4B4B] text-xs font-black text-[#EA2B2B]">
                  <span>
                    {pendingQueue.length > 0
                      ? 'انتهى الوقت — يمكنك تصحيح الإجابات المرسلة أدناه أو إغلاق السؤال الآن.'
                      : 'انتهى وقت السؤال ولم يرسل أحد الحل — أغلق السؤال لتتمكن من إدراج السؤال التالي.'}
                  </span>
                  <button
                    type="button"
                    disabled={gradingBusy}
                    onClick={handleCloseQuestionUnanswered}
                    className="duo-btn px-3.5 py-1.5 rounded-xl bg-[#FF4B4B] border-2 border-b-3 border-[#EA2B2B] text-white text-xs font-black cursor-pointer"
                  >
                    إغلاق السؤال الآن
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-3 sm:gap-4">
            <div className="flex flex-col md:flex-row gap-3 sm:gap-4 items-start md:items-center justify-between">
              <div className="flex-1 min-w-0 flex flex-col gap-2">
                {currentQuestion.sourceQuizTitle && (
                  <span className="self-start px-2.5 py-0.5 rounded-lg bg-[#F3E8FF] border border-[#CE82FF] text-[11px] font-black text-[#6D23B6]">
                    من اختبار: {currentQuestion.sourceQuizTitle}
                  </span>
                )}
                {currentQuestion.text && (
                  <MathText
                    text={currentQuestion.text}
                    className="text-base sm:text-xl font-black text-[#3C3C3C] leading-relaxed"
                  />
                )}
              </div>

              {currentQuestion.imageData && (
                isSupervisor ? (
                  <button
                    type="button"
                    onClick={() => setZoomedImage(currentQuestion.imageData)}
                    className="group relative rounded-2xl overflow-hidden border-2 border-[#E5E5E5] bg-[#F7F7F7] w-full sm:w-auto sm:max-w-sm cursor-pointer shrink-0 flex justify-center"
                  >
                    <img
                      src={currentQuestion.imageData}
                      alt="صورة السؤال"
                      className="max-h-44 sm:max-h-52 w-auto object-contain"
                    />
                    <span className="absolute bottom-2 left-2 bg-black/70 text-white text-xs font-bold px-2.5 py-1 rounded-lg flex items-center gap-1">
                      <ZoomIn className="w-3.5 h-3.5" />
                      <span>تكبير الصفحة / الصورة</span>
                    </span>
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2 w-full md:w-auto">
                    {!currentQuestion.text && (
                      <span className="text-sm font-black text-[#1899D6]">
                        تم عرض الصفحة داخل سبورتك بالأسفل — اكتب وحل عليها مباشرة!
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setZoomedImage(currentQuestion.imageData)}
                      className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#DDF4FF] border-2 border-b-3 border-[#1CB0F6] text-[#1899D6] text-xs font-black cursor-pointer whitespace-nowrap"
                    >
                      <ZoomIn className="w-4 h-4" />
                      <span>تكبير الورقة الأصلية</span>
                    </button>
                  </div>
                )
              )}
            </div>

            {currentQuestion.chart && (
              <ChartView chart={currentQuestion.chart} className="max-w-xl w-full" />
            )}

            {currentQuestion.choices && currentQuestion.choices.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {currentQuestion.choices.map((ch, idx) => {
                  const labels = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح'];
                  const privateMeta = isSupervisor ? quizAnswerCache[currentQuestion.id] : undefined;
                  const isCorrectForSupervisor = privateMeta && privateMeta.correctIndex === idx;
                  return (
                    <div
                      key={idx}
                      className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl border-2 text-sm font-black ${
                        isCorrectForSupervisor
                          ? 'bg-[#D7FFB8] border-[#58CC02] text-[#264E00]'
                          : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#3C3C3C]'
                      }`}
                    >
                      <span
                        className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-black shrink-0 ${
                          isCorrectForSupervisor
                            ? 'bg-[#58CC02] text-white'
                            : 'bg-white border border-[#E5E5E5] text-[#777777]'
                        }`}
                      >
                        {labels[idx] || idx + 1}
                      </span>
                      <MathText text={ch} className="flex-1 min-w-0 font-black" />
                    </div>
                  );
                })}
              </div>
            )}

            {isSupervisor && quizAnswerCache[currentQuestion.id] && (
              <div className="rounded-2xl bg-[#D7FFB8]/65 border-2 border-[#58CC02] p-3.5 flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-black text-[#46A302]">
                    الإجابة الصحيحة (سري للمشرف فقط):
                  </span>
                  <span className="text-[11px] font-bold text-[#46A302]">
                    لا تظهر للطلاب
                  </span>
                </div>
                {quizAnswerCache[currentQuestion.id].answer && (
                  <MathText
                    text={quizAnswerCache[currentQuestion.id].answer}
                    className="text-sm sm:text-base font-black text-[#264E00]"
                  />
                )}
                {quizAnswerCache[currentQuestion.id].explanation && (
                  <div className="text-xs sm:text-sm font-bold text-[#3C3C3C] pt-1 border-t border-[#58CC02]/30">
                    <span className="font-black text-[#46A302]">الشرح: </span>
                    <MathText text={quizAnswerCache[currentQuestion.id].explanation} className="inline" />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Supervisor-only Private AI Solution Panel for the Active Question */}
          {isSupervisor && activeAiOpen && (
            <div className="rounded-2xl bg-[#F8EDFF] border-2 border-[#CE82FF] p-4 sm:p-5 flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-[#A560E8] text-white flex items-center justify-center shrink-0">
                    <Bot className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-sm sm:text-base font-black text-[#5C1A99]">
                      مساعد الذكاء الاصطناعي للمشرف
                    </h4>
                    <span className="text-[11px] font-extrabold text-[#8938D6]">
                      سري للمشرف فقط — لا يظهر للطلاب نهائياً
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveAiOpen(false)}
                  className="p-1.5 rounded-xl bg-white hover:bg-[#FFDFE0] text-[#3C3C3C] cursor-pointer"
                  title="إخفاء"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {activeAiLoading ? (
                <div className="flex items-center justify-center gap-2.5 py-6 text-sm font-black text-[#8938D6]">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>جاري قراءة السؤال وتحليل الطريقة والإجابة الصحيحة...</span>
                </div>
              ) : activeAiError ? (
                <div className="p-3 rounded-xl bg-[#FFDFE0] border border-[#FF4B4B] text-xs sm:text-sm font-extrabold text-[#EA2B2B]">
                  {activeAiError}
                </div>
              ) : activeAiCache[currentQuestion.id] ? (
                <div className="flex flex-col gap-3">
                  <div className="p-3.5 rounded-2xl bg-[#D7FFB8] border-2 border-[#58CC02] flex flex-col gap-1">
                    <span className="text-xs font-black text-[#46A302]">
                      الإجابة الصحيحة النهائية:
                    </span>
                    <p className="text-base sm:text-lg font-black text-[#264E00] whitespace-pre-wrap">
                      {activeAiCache[currentQuestion.id].finalAnswer}
                    </p>
                  </div>

                  {activeAiCache[currentQuestion.id].steps.length > 0 && (
                    <div className="rounded-2xl bg-white border-2 border-[#E7C6FF] p-3.5 flex flex-col gap-2">
                      <span className="text-xs font-black text-[#8938D6]">
                        كيفية الحل خطوة بخطوة:
                      </span>
                      <ol className="flex flex-col gap-2">
                        {activeAiCache[currentQuestion.id].steps.map((step, idx) => (
                          <li
                            key={idx}
                            className="flex items-start gap-2.5 text-xs sm:text-sm font-bold text-[#3C3C3C] leading-relaxed"
                          >
                            <span className="font-latin w-6 h-6 rounded-lg bg-[#CE82FF]/25 text-[#6D23B6] flex items-center justify-center text-xs font-black shrink-0 mt-0.5">
                              {idx + 1}
                            </span>
                            <span className="whitespace-pre-wrap">{step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {activeAiCache[currentQuestion.id].explanation && (
                    <div className="rounded-2xl bg-white/80 border border-[#E7C6FF] p-3 text-xs sm:text-sm font-bold text-[#524364] leading-relaxed whitespace-pre-wrap">
                      <span className="font-black text-[#8938D6]">توضيح وفكرة الحل: </span>
                      {activeAiCache[currentQuestion.id].explanation}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : (
        <div className="duo-card p-6 bg-[#F7F7F7] flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-black text-[#3C3C3C]">
              {isSupervisor
                ? 'أدرج السؤال الأول من لوحة الإعداد السرية أدناه'
                : 'الجميع في غرفة السبورة — بانتظار المشرف لإدراج السؤال الأول'}
            </h2>
            <p className="text-sm font-bold text-[#777777]">
              {isSupervisor
                ? 'لن يرى الطلاب نص السؤال أو صورته أثناء كتابتك حتى تضغط «أدرج السؤال للجميع»'
                : 'لا يمكنك الكتابة على السبورة إلا بعد أن يُدرج المشرف السؤال'}
            </p>
          </div>
        </div>
      )}

      {/* ==================== SUPERVISOR VIEW ==================== */}
      {isSupervisor ? (
        <div className="flex flex-col gap-6">
          {/* Pending Submission Spotlight (Student 1 -> Student 2 Review) */}
          {currentQuestion && currentQuestion.status === 'solving' && activeReviewBoard && (
            <div className="duo-card p-5 sm:p-6 border-[#FFC800] bg-[#FFF4CC]/55 flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Sparkles className="w-6 h-6 text-[#E5A400]" />
                  <div>
                    <span className="text-xs font-extrabold text-[#B88200] block">
                      {currentQuestion.attemptsUsed === 0
                        ? 'المحاولة الأولى (الطالب الأول)'
                        : 'المحاولة الثانية (تحوّل السؤال للطالب الثاني)'}
                    </span>
                    <h3 className="text-xl font-black text-[#3C3C3C]">
                      أتمّ الطالب: {activeReviewBoard.studentName}
                    </h3>
                  </div>
                </div>

                {pendingQueue.length > 1 && (
                  <span className="text-xs font-extrabold text-[#777777]">
                    في الانتظار بعده: {pendingQueue.length - 1} طالب
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-center">
                <div className="lg:col-span-2 relative">
                  <WhiteboardPreview
                    strokes={activeReviewBoard.strokes || []}
                    backgroundImage={currentQuestion.imageData || undefined}
                    className="w-full aspect-[12/7]"
                  />
                  <button
                    type="button"
                    onClick={() => setInspectedBoard(activeReviewBoard)}
                    className="duo-btn absolute bottom-3 left-3 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/95 hover:bg-[#DDF4FF] border-2 border-[#E5E5E5] text-xs font-black text-[#1899D6] cursor-pointer shadow-sm"
                  >
                    <ZoomIn className="w-4 h-4" />
                    <span>تكبير الحل والتفاصيل</span>
                  </button>
                </div>
                <div className="flex flex-col gap-3">
                  <p className="text-sm font-bold text-[#3C3C3C]">
                    تحقق من حل الطالب على السبورة ثم اعتمد النتيجة:
                  </p>
                  <button
                    type="button"
                    disabled={gradingBusy}
                    onClick={() => handleGradeBoard(activeReviewBoard, true)}
                    className="duo-btn w-full flex items-center justify-center gap-2 px-6 py-4 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-[#46A302] border-b-[5px] text-white text-lg font-black cursor-pointer disabled:opacity-60"
                  >
                    <Check className="w-6 h-6 stroke-[3]" />
                    <span>إجابة صحيحة (صح)</span>
                  </button>
                  <button
                    type="button"
                    disabled={gradingBusy}
                    onClick={() => handleGradeBoard(activeReviewBoard, false)}
                    className="duo-btn w-full flex items-center justify-center gap-2 px-6 py-4 rounded-2xl bg-[#FF4B4B] hover:bg-[#FF6161] border-2 border-[#EA2B2B] border-b-[5px] text-white text-lg font-black cursor-pointer disabled:opacity-60"
                  >
                    <X className="w-6 h-6 stroke-[3]" />
                    <span>
                      {currentQuestion.attemptsUsed === 0 && participants.length >= 2
                        ? 'إجابة خاطئة (تحويل للثاني)'
                        : 'إجابة خاطئة (غلط)'}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Private Supervisor Question Composer (Invisible to Students until Inserted) */}
          {(!currentQuestion || currentQuestion.status !== 'solving') && (
            <form
              onSubmit={handleInsertQuestion}
              className="duo-card p-5 sm:p-6 flex flex-col gap-4 border-[#1CB0F6]"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <EyeOff className="w-5 h-5 text-[#1899D6]" />
                  <h3 className="text-lg font-black text-[#3C3C3C]">
                    إعداد السؤال {questions.length + 1} (خاص بالمشرف فقط)
                  </h3>
                </div>

                {/* Mode Tabs: Text/Image, Imported Quizzes, PDF Page Picker, OR Supervisor's Private Whiteboard */}
                <div className="flex items-center gap-1 p-1 bg-[#F7F7F7] border-2 border-[#E5E5E5] rounded-xl w-full sm:w-auto overflow-x-auto">
                  <button
                    type="button"
                    onClick={() => setComposerTab('text')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-black transition-colors cursor-pointer whitespace-nowrap ${
                      composerTab === 'text'
                        ? 'bg-white text-[#1899D6] shadow-sm'
                        : 'text-[#777777] hover:text-[#3C3C3C]'
                    }`}
                  >
                    <Type className="w-3.5 h-3.5" />
                    <span>كتابة نص / صورة</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setComposerTab('quizzes')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-black transition-colors cursor-pointer whitespace-nowrap ${
                      composerTab === 'quizzes'
                        ? 'bg-white text-[#8938D6] shadow-sm'
                        : 'text-[#777777] hover:text-[#3C3C3C]'
                    }`}
                  >
                    <ListChecks className="w-3.5 h-3.5" />
                    <span>
                      من الاختبارات ({roomQuizPool.length})
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setComposerTab('pdf')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-black transition-colors cursor-pointer whitespace-nowrap ${
                      composerTab === 'pdf'
                        ? 'bg-white text-[#9A6B00] shadow-sm'
                        : 'text-[#777777] hover:text-[#3C3C3C]'
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>
                      {pdfDocs.length > 0
                        ? `ملفات PDF (${pdfDocs.length})`
                        : 'تحديد صفحة من PDF'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setComposerTab('board')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-black transition-colors cursor-pointer whitespace-nowrap ${
                      composerTab === 'board'
                        ? 'bg-white text-[#46A302] shadow-sm'
                        : 'text-[#777777] hover:text-[#3C3C3C]'
                    }`}
                  >
                    <PenTool className="w-3.5 h-3.5" />
                    <span>رسم على سبورة المشرف</span>
                  </button>
                </div>
              </div>

              {composerTab === 'quizzes' ? (
                <div className="flex flex-col gap-4">
                  <RoomQuizSyncBanner
                    roomId={room.id}
                    profile={profile}
                    isSupervisor={isSupervisor}
                    compact
                    onImportedQuizPoolId={(poolId) => {
                      setSelectedPoolQuizIds((prev) =>
                        prev.includes(poolId) ? prev : [...prev, poolId]
                      );
                    }}
                  />

                  {roomQuizPool.length === 0 ? (
                    <div className="p-6 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] text-center flex flex-col items-center gap-2">
                      <ListChecks className="w-8 h-8 text-[#AFAFAF]" />
                      <p className="text-sm font-black text-[#3C3C3C]">
                        لا توجد اختبارات مضافة في الغرفة بعد
                      </p>
                      <p className="text-xs font-bold text-[#777777]">
                        اضغط على «استيراد اختبار JSON للغرفة» بالأعلى، أو أضف اختبارات من تبويب «اختباراتي»، وستظهر اختباراتك واختبارات الطلاب هنا مباشرة.
                      </p>
                    </div>
                  ) : (
                    <>
                      {/* Multi-quiz selection grid */}
                      <div className="flex flex-col gap-2.5 bg-[#F7F7F7] border-2 border-[#E5E5E5] rounded-2xl p-3.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-black text-[#3C3C3C]">
                            اختر اختباراً أو مجموعة اختبارات لعرض أسئلتها واختيار ما تريده:
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedPoolQuizIds(roomQuizPool.map((e) => e.poolId))
                              }
                              className="text-xs font-black text-[#1899D6] hover:underline cursor-pointer"
                            >
                              تحديد الكل
                            </button>
                            {selectedPoolQuizIds.length > 0 && (
                              <button
                                type="button"
                                onClick={() => setSelectedPoolQuizIds([])}
                                className="text-xs font-black text-[#EA2B2B] hover:underline cursor-pointer"
                              >
                                إلغاء التحديد
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                          {roomQuizPool.map((entry) => {
                            const selected = selectedPoolQuizIds.includes(entry.poolId);
                            return (
                              <button
                                key={entry.poolId}
                                type="button"
                                onClick={() => {
                                  setSelectedPoolQuizIds((prev) =>
                                    prev.includes(entry.poolId)
                                      ? prev.filter((id) => id !== entry.poolId)
                                      : [...prev, entry.poolId]
                                  );
                                  playDuoSound('pop');
                                }}
                                className={`text-right p-3 rounded-xl border-2 transition-all flex items-start gap-2.5 cursor-pointer ${
                                  selected
                                    ? 'bg-[#F3E8FF] border-[#A560E8]'
                                    : 'bg-white border-[#E5E5E5] hover:border-[#CE82FF]'
                                }`}
                              >
                                <div
                                  className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                                    selected
                                      ? 'bg-[#A560E8] border-[#8938D6] text-white'
                                      : 'bg-white border-[#CFCFCF]'
                                  }`}
                                >
                                  {selected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs sm:text-sm font-black text-[#3C3C3C] truncate">
                                    {entry.quiz.title}
                                  </p>
                                  <div className="flex flex-wrap items-center gap-1.5 mt-1">
                                    <span
                                      className={`px-2 py-0.5 rounded-md text-[10px] font-black ${
                                        entry.authorRole === 'supervisor'
                                          ? 'bg-[#D7FFB8] text-[#46A302]'
                                          : 'bg-[#DDF4FF] text-[#1899D6]'
                                      }`}
                                    >
                                      {entry.isMine
                                        ? 'من اختباراتك'
                                        : `طالب: ${entry.authorName}`}
                                    </span>
                                    <span className="font-latin text-[11px] font-bold text-[#777777]">
                                      {entry.quiz.questions.length} سؤال
                                    </span>
                                  </div>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Filter & Include choices option */}
                      <div className="flex flex-wrap items-center justify-between gap-2.5">
                        <div className="relative flex-1 min-w-[200px]">
                          <Search className="w-4 h-4 text-[#AFAFAF] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                          <input
                            type="text"
                            value={quizQuestionSearch}
                            onChange={(e) => setQuizQuestionSearch(e.target.value)}
                            placeholder="ابحث داخل أسئلة الاختبارات المحددة..."
                            className="w-full pr-9 pl-3 py-2 rounded-xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#A560E8] focus:bg-white outline-none text-xs sm:text-sm font-bold text-[#3C3C3C]"
                          />
                        </div>

                        <label className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[#F7F7F7] border-2 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={includeQuizChoices}
                            onChange={(e) => setIncludeQuizChoices(e.target.checked)}
                            className="w-4 h-4 accent-[#A560E8]"
                          />
                          <span>إظهار الخيارات للطلاب مع السؤال</span>
                        </label>
                      </div>

                      {/* Questions list from selected quizzes */}
                      {(() => {
                        const chosenEntries =
                          selectedPoolQuizIds.length > 0
                            ? roomQuizPool.filter((e) => selectedPoolQuizIds.includes(e.poolId))
                            : roomQuizPool;
                        const term = quizQuestionSearch.trim().toLowerCase();
                        const items: { qq: QuizQuestion; entry: RoomQuizEntry; idxInQuiz: number }[] = [];
                        for (const entry of chosenEntries) {
                          entry.quiz.questions.forEach((qq, i) => {
                            if (
                              !term ||
                              qq.text.toLowerCase().includes(term) ||
                              entry.quiz.title.toLowerCase().includes(term) ||
                              entry.authorName.toLowerCase().includes(term)
                            ) {
                              items.push({ qq, entry, idxInQuiz: i + 1 });
                            }
                          });
                        }

                        if (items.length === 0) {
                          return (
                            <p className="text-xs font-bold text-[#777777] py-4 text-center">
                              لا توجد أسئلة مطابقة للبحث في النماذج المحددة.
                            </p>
                          );
                        }

                        return (
                          <div className="flex flex-col gap-3 max-h-[430px] overflow-y-auto pr-1">
                            {items.map(({ qq, entry, idxInQuiz }) => (
                              <div
                                key={`${entry.poolId}_${qq.id}_${idxInQuiz}`}
                                className="rounded-2xl border-2 border-[#E5E5E5] bg-white p-3.5 sm:p-4 flex flex-col gap-2.5"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-latin px-2 py-0.5 rounded-lg bg-[#A560E8] text-white text-[11px] font-black">
                                      س{idxInQuiz}
                                    </span>
                                    <span className="px-2 py-0.5 rounded-lg bg-[#F3E8FF] text-[#6D23B6] text-[11px] font-black">
                                      {entry.quiz.title}
                                    </span>
                                    <span className="text-[11px] font-bold text-[#777777]">
                                      ({entry.isMine ? 'لك' : entry.authorName})
                                    </span>
                                  </div>

                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => handleLoadQuizQuestionToDraft(qq, entry)}
                                      className="duo-btn px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] hover:border-[#1CB0F6] text-[#1899D6] text-xs font-black cursor-pointer"
                                    >
                                      تحميل للتعديل
                                    </button>
                                    <button
                                      type="button"
                                      disabled={insertingQuestion}
                                      onClick={() => void handleInsertQuizQuestionDirect(qq, entry)}
                                      className="duo-btn flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-3 border-[#46A302] text-white text-xs font-black cursor-pointer disabled:opacity-60"
                                    >
                                      <Send className="w-3.5 h-3.5" />
                                      <span>إدراج للجميع الآن</span>
                                    </button>
                                  </div>
                                </div>

                                <MathText
                                  text={qq.text}
                                  className="text-sm sm:text-base font-black text-[#3C3C3C]"
                                />

                                {qq.chart && <ChartView chart={qq.chart} className="max-w-md w-full" />}

                                {qq.choices && qq.choices.length > 0 && (
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                    {qq.choices.map((c, cIdx) => (
                                      <div
                                        key={cIdx}
                                        className={`px-2.5 py-1.5 rounded-xl border text-xs font-bold flex items-center gap-1.5 ${
                                          cIdx === qq.correctIndex
                                            ? 'bg-[#D7FFB8] border-[#58CC02] text-[#264E00] font-black'
                                            : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#3C3C3C]'
                                        }`}
                                      >
                                        {cIdx === qq.correctIndex && (
                                          <Check className="w-3.5 h-3.5 text-[#46A302] shrink-0" />
                                        )}
                                        <MathText text={c} className="flex-1 min-w-0" />
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {qq.explanation && (
                                  <div className="text-xs font-bold text-[#6D23B6] bg-[#F8EDFF] rounded-xl px-3 py-1.5">
                                    <span className="font-black">الشرح السري: </span>
                                    <MathText text={qq.explanation} className="inline" />
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </>
                  )}
                </div>
              ) : composerTab === 'text' ? (
                <div className="flex flex-col gap-3">
                  {draftQuizAttachment && (
                    <div className="p-3 rounded-2xl bg-[#F3E8FF] border-2 border-[#CE82FF] flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-black text-[#6D23B6]">
                        مرفق سؤال من الاختبار ({draftQuizAttachment.answerMeta?.sourceQuizTitle || 'اختبار'})
                        {draftQuizAttachment.chart ? ' · يحتوي رسم بياني' : ''}
                        {draftQuizAttachment.choices?.length ? ` · ${draftQuizAttachment.choices.length} خيارات` : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => setDraftQuizAttachment(null)}
                        className="text-xs font-black text-[#EA2B2B] hover:underline cursor-pointer"
                      >
                        إزالة المرفق
                      </button>
                    </div>
                  )}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <div className="lg:col-span-2 flex flex-col gap-2">
                    <label
                      htmlFor="question-draft-text"
                      className="text-xs font-extrabold text-[#3C3C3C]"
                    >
                      نص السؤال
                    </label>
                    <textarea
                      id="question-draft-text"
                      rows={3}
                      maxLength={2000}
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                      placeholder="اكتب سؤالك هنا... (أو استورد سؤالاً من تبويب «من الاختبارات» أو PDF أو ارسمه على سبورة المشرف)"
                      className="w-full px-4 py-3 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#1CB0F6] focus:bg-white outline-none text-base font-bold text-[#3C3C3C] resize-none"
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-extrabold text-[#3C3C3C]">
                      صورة السؤال (اختياري)
                    </span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleImagePick}
                      className="hidden"
                    />
                    {draftImage ? (
                      <div className="relative rounded-2xl border-2 border-[#E5E5E5] bg-[#F7F7F7] p-2 flex items-center justify-center h-28">
                        <img
                          src={draftImage}
                          alt="معاينة الصورة"
                          className="max-h-full max-w-full object-contain rounded-lg"
                        />
                        <button
                          type="button"
                          onClick={() => setDraftImage('')}
                          className="absolute top-2 left-2 p-1.5 rounded-lg bg-[#FF4B4B] text-white cursor-pointer"
                          title="حذف الصورة"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="duo-btn h-28 rounded-2xl border-2 border-dashed border-[#1CB0F6] bg-[#DDF4FF]/40 hover:bg-[#DDF4FF] flex flex-col items-center justify-center gap-2 text-[#1899D6] font-extrabold text-sm cursor-pointer"
                      >
                        <ImagePlus className="w-6 h-6" />
                        <span>رفع صورة من جهازك</span>
                      </button>
                    )}
                  </div>
                </div>
                </div>
              ) : composerTab === 'pdf' ? (
                <div className="flex flex-col gap-4">
                  <input
                    ref={pdfInputRef}
                    type="file"
                    accept="application/pdf"
                    multiple
                    onChange={handlePdfPick}
                    className="hidden"
                  />

                  {pdfLoading ? (
                    <div className="p-8 rounded-2xl bg-[#FFF4CC]/60 border-2 border-[#FFC800] text-center text-sm font-black text-[#9A6B00]">
                      {pdfProgress || 'جاري تجهيز صفحات ملفات PDF...'}
                    </div>
                  ) : !activePdfDoc ? (
                    <button
                      type="button"
                      onClick={() => pdfInputRef.current?.click()}
                      className="duo-btn py-10 px-6 rounded-2xl border-2 border-dashed border-[#FFC800] bg-[#FFF4CC]/40 hover:bg-[#FFF4CC]/75 flex flex-col items-center justify-center gap-2.5 text-[#9A6B00] cursor-pointer"
                    >
                      <FileText className="w-9 h-9" />
                      <span className="text-base font-black">
                        ارفع ملفاً أو عدة ملفات PDF لاختيار أي سؤال منها وإظهاره للطلاب
                      </span>
                      <span className="text-xs font-bold text-[#777777]">
                        لا يظهر أي ملف للطلاب نهائياً — تبقى جميع الملفات في مكتبتك وتظهر فقط الصفحة التي تحددها
                      </span>
                    </button>
                  ) : (
                    <div className="flex flex-col gap-3 bg-[#F7F7F7] border-2 border-[#E5E5E5] rounded-2xl p-3.5 sm:p-4">
                      {/* Multi-PDF Private Library Switcher */}
                      <div className="flex flex-col gap-2.5 pb-3 border-b-2 border-[#E5E5E5]">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-black text-[#9A6B00]">
                            مكتبة ملفات PDF الخاصة بك ({pdfDocs.length}{' '}
                            {pdfDocs.length === 1 ? 'ملف' : 'ملفات'}):
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => pdfInputRef.current?.click()}
                              className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#DDF4FF] border-2 border-b-3 border-[#1CB0F6] text-xs font-black text-[#1899D6] cursor-pointer"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              <span>إضافة ملف PDF آخر</span>
                            </button>
                            {pdfDocs.length > 1 && (
                              <button
                                type="button"
                                onClick={() => {
                                  setPdfDocs([]);
                                  setActivePdfId(null);
                                }}
                                className="duo-btn px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#EA2B2B] cursor-pointer"
                              >
                                مسح الكل
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Uploaded PDF File Tabs */}
                        <div className="flex items-center gap-2 overflow-x-auto pb-1">
                          {pdfDocs.map((docItem, idx) => {
                            const isActive = docItem.id === activePdfDoc.id;
                            return (
                              <div
                                key={docItem.id}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border-2 shrink-0 ${
                                  isActive
                                    ? 'bg-[#FFC800] border-[#E5A400] text-[#3C3C3C]'
                                    : 'bg-white border-[#E5E5E5] text-[#777777] hover:text-[#3C3C3C]'
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={() => setActivePdfId(docItem.id)}
                                  className="flex items-center gap-1.5 text-xs font-black cursor-pointer"
                                >
                                  <FileText className="w-3.5 h-3.5 shrink-0" />
                                  <span className="truncate max-w-[160px]">
                                    {idx + 1}. {docItem.fileName}
                                  </span>
                                  <span className="font-latin text-[11px] opacity-80">
                                    ({docItem.pages.length} ص)
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPdfDocs((prev) => {
                                      const next = prev.filter((d) => d.id !== docItem.id);
                                      if (activePdfId === docItem.id) {
                                        setActivePdfId(next[0]?.id ?? null);
                                      }
                                      return next;
                                    });
                                  }}
                                  className="p-0.5 rounded-md hover:bg-black/10 text-[#3C3C3C] cursor-pointer"
                                  title="إزالة هذا الملف"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Page Selector Strip for Active PDF */}
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={activePdfDoc.selectedPage <= 1}
                            onClick={() =>
                              setActivePdfPage(
                                activePdfDoc.id,
                                Math.max(1, activePdfDoc.selectedPage - 1)
                              )
                            }
                            className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer disabled:opacity-40"
                          >
                            <ChevronRight className="w-4 h-4" />
                            <span>السابقة</span>
                          </button>
                          <span className="font-latin px-3 py-1 rounded-xl bg-[#FFC800] text-[#3C3C3C] text-xs font-black">
                            الصفحة المحددة: {activePdfDoc.selectedPage} / {activePdfDoc.pages.length}
                          </span>
                          <button
                            type="button"
                            disabled={activePdfDoc.selectedPage >= activePdfDoc.pages.length}
                            onClick={() =>
                              setActivePdfPage(
                                activePdfDoc.id,
                                Math.min(
                                  activePdfDoc.pages.length,
                                  activePdfDoc.selectedPage + 1
                                )
                              )
                            }
                            className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer disabled:opacity-40"
                          >
                            <span>التالية</span>
                            <ChevronLeft className="w-4 h-4" />
                          </button>
                        </div>

                        <div className="flex items-center gap-1.5 overflow-x-auto max-w-full py-1">
                          {activePdfDoc.pages.map((_, idx) => {
                            const pageNum = idx + 1;
                            return (
                              <button
                                key={pageNum}
                                type="button"
                                onClick={() => setActivePdfPage(activePdfDoc.id, pageNum)}
                                className={`font-latin min-w-[30px] h-7 px-2 rounded-lg text-xs font-black cursor-pointer shrink-0 ${
                                  activePdfDoc.selectedPage === pageNum
                                    ? 'bg-[#1CB0F6] text-white border-2 border-[#1899D6]'
                                    : 'bg-white text-[#777777] border border-[#E5E5E5] hover:text-[#3C3C3C]'
                                }`}
                              >
                                {pageNum}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Optional Note + Private Preview of Selected Page */}
                      <input
                        type="text"
                        maxLength={1000}
                        value={draftText}
                        onChange={(e) => setDraftText(e.target.value)}
                        placeholder={`ملاحظة أو عنوان للطلاب مع صفحة ${activePdfDoc.selectedPage} من (${activePdfDoc.fileName})...`}
                        className="w-full px-4 py-2.5 rounded-2xl bg-white border-2 border-[#E5E5E5] focus:border-[#1CB0F6] outline-none text-sm font-bold text-[#3C3C3C]"
                      />

                      <div className="rounded-2xl border-2 border-[#E5E5E5] bg-white p-2 flex items-center justify-center max-h-[340px] overflow-hidden">
                        <img
                          src={activePdfDoc.pages[activePdfDoc.selectedPage - 1]}
                          alt={`معاينة صفحة ${activePdfDoc.selectedPage}`}
                          className="max-h-[315px] w-auto object-contain rounded-lg"
                        />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-extrabold text-[#46A302]">
                      اكتب أو ارسم سؤالك على سبورتك السرية هنا (لا يراه الطلاب إلا بعد الضغط على «أدرج السؤال»)
                    </span>
                    {draftImage && (
                      <span className="text-xs font-bold text-[#777777]">
                        ملاحظة: توجد صورة مرفوعة — احذفها إذا أردت اعتماد رسم السبورة كصورة للسؤال
                      </span>
                    )}
                  </div>

                  <input
                    type="text"
                    maxLength={1000}
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    placeholder="عنوان أو نص مختصر للسؤال (اختياري)..."
                    className="w-full px-4 py-2.5 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#58CC02] focus:bg-white outline-none text-sm font-bold text-[#3C3C3C]"
                  />

                  <WhiteboardCanvas
                    strokes={draftBoardStrokes}
                    onStrokesChange={setDraftBoardStrokes}
                    heightClass="h-[250px] sm:h-[340px] md:h-[400px]"
                  />
                </div>
              )}

              {/* Per-Question Timer Picker (Automatically inherits previous question's timer) */}
              <div className="rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] p-3.5 sm:p-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-xl bg-[#DDF4FF] border-2 border-[#1CB0F6] text-[#1899D6] flex items-center justify-center shrink-0">
                      <Clock className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="text-xs sm:text-sm font-black text-[#3C3C3C] block">
                        مؤقت السؤال ({formatTimerArabic(draftTimerSeconds)})
                      </span>
                      <span className="text-[11px] font-bold text-[#777777]">
                        {previousTimerSeconds !== null
                          ? draftTimerSeconds === previousTimerSeconds
                            ? `مضبوط تلقائياً على مدة السؤال السابق (${formatTimerArabic(previousTimerSeconds)})`
                            : `تم التعديل عن السؤال السابق (${formatTimerArabic(previousTimerSeconds)})`
                          : 'يُحفظ هذا التوقيت تلقائياً لكل سؤال قادم ما لم تغيّره'}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {previousTimerSeconds !== null && draftTimerSeconds !== previousTimerSeconds && (
                      <button
                        type="button"
                        onClick={() => setDraftTimerSeconds(previousTimerSeconds)}
                        className="duo-btn flex items-center gap-1 px-2.5 py-1 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-[11px] font-black text-[#1899D6] cursor-pointer"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>نفس السابق</span>
                      </button>
                    )}

                    <div className="flex items-center gap-1 bg-white border-2 border-[#E5E5E5] rounded-xl px-1.5 py-1">
                      <button
                        type="button"
                        onClick={() =>
                          setDraftTimerSeconds((s) => Math.max(0, s - 15))
                        }
                        className="w-7 h-7 rounded-lg bg-[#F7F7F7] hover:bg-[#FFDFE0] text-[#3C3C3C] flex items-center justify-center cursor-pointer"
                        title="إنقاص 15 ثانية"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span className="font-latin min-w-[54px] text-center text-xs sm:text-sm font-black text-[#1899D6]">
                        {draftTimerSeconds === 0 ? 'مفتوح' : formatTimerClock(draftTimerSeconds)}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setDraftTimerSeconds((s) => Math.min(3600, s + 15))
                        }
                        className="w-7 h-7 rounded-lg bg-[#F7F7F7] hover:bg-[#D7FFB8] text-[#3C3C3C] flex items-center justify-center cursor-pointer"
                        title="زيادة 15 ثانية"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                  {TIMER_PRESETS.map((preset) => {
                    const active = draftTimerSeconds === preset.seconds;
                    return (
                      <button
                        key={preset.seconds}
                        type="button"
                        onClick={() => setDraftTimerSeconds(preset.seconds)}
                        className={`duo-btn px-3 py-1.5 rounded-xl border-2 border-b-3 text-xs font-black cursor-pointer shrink-0 whitespace-nowrap ${
                          active
                            ? preset.seconds === 0
                              ? 'bg-[#FFC800] border-[#E5A400] text-[#3C3C3C]'
                              : 'bg-[#1CB0F6] border-[#1899D6] text-white'
                            : 'bg-white border-[#E5E5E5] text-[#777777] hover:text-[#3C3C3C]'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {draftError && (
                <p className="text-sm font-extrabold text-[#EA2B2B]">{draftError}</p>
              )}

              {draftAiError && (
                <div className="p-3 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-xs sm:text-sm font-extrabold text-[#EA2B2B]">
                  {draftAiError}
                </div>
              )}

              {/* Supervisor-only AI Preview Solution inside Composer */}
              {draftAiSolution && (
                <div className="rounded-2xl bg-[#F8EDFF] border-2 border-[#CE82FF] p-4 sm:p-5 flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-xl bg-[#A560E8] text-white flex items-center justify-center shrink-0">
                        <Bot className="w-4 h-4" />
                      </div>
                      <div>
                        <h4 className="text-sm sm:text-base font-black text-[#5C1A99]">
                          الإجابة والطريقة بالذكاء الاصطناعي
                        </h4>
                        <span className="text-[11px] font-extrabold text-[#8938D6]">
                          سرية للمشرف فقط — لن يراها الطلاب عند إدراج السؤال
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDraftAiSolution(null)}
                      className="p-1.5 rounded-xl bg-white hover:bg-[#FFDFE0] text-[#3C3C3C] cursor-pointer"
                      title="إغلاق"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="p-3.5 rounded-2xl bg-[#D7FFB8] border-2 border-[#58CC02] flex flex-col gap-1">
                    <span className="text-xs font-black text-[#46A302]">
                      الإجابة الصحيحة النهائية:
                    </span>
                    <p className="text-base sm:text-lg font-black text-[#264E00] whitespace-pre-wrap">
                      {draftAiSolution.finalAnswer}
                    </p>
                  </div>

                  {draftAiSolution.steps.length > 0 && (
                    <div className="rounded-2xl bg-white border-2 border-[#E7C6FF] p-3.5 flex flex-col gap-2">
                      <span className="text-xs font-black text-[#8938D6]">
                        كيفية الحل خطوة بخطوة:
                      </span>
                      <ol className="flex flex-col gap-2">
                        {draftAiSolution.steps.map((step, idx) => (
                          <li
                            key={idx}
                            className="flex items-start gap-2.5 text-xs sm:text-sm font-bold text-[#3C3C3C] leading-relaxed"
                          >
                            <span className="font-latin w-6 h-6 rounded-lg bg-[#CE82FF]/25 text-[#6D23B6] flex items-center justify-center text-xs font-black shrink-0 mt-0.5">
                              {idx + 1}
                            </span>
                            <span className="whitespace-pre-wrap">{step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {draftAiSolution.explanation && (
                    <div className="rounded-2xl bg-white/80 border border-[#E7C6FF] p-3 text-xs sm:text-sm font-bold text-[#524364] leading-relaxed whitespace-pre-wrap">
                      <span className="font-black text-[#8938D6]">توضيح وفكرة الحل: </span>
                      {draftAiSolution.explanation}
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <span className="text-xs font-bold text-[#777777]">
                  {composerTab === 'pdf' && activePdfDoc
                    ? `ستظهر صفحة ${activePdfDoc.selectedPage} من (${activePdfDoc.fileName}) فقط للطلاب ليبدأوا الحل عليها`
                    : draftBoardStrokes.length > 0 && !draftImage
                    ? 'سيتم إرفاق رسم سبورتك الخاصة مع السؤال تلقائياً'
                    : 'لا يظهر للطلاب أي شيء حتى تضغط زر الإدراج'}
                </span>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
                  <button
                    type="button"
                    disabled={draftAiLoading || pdfLoading}
                    onClick={() => void handleAskAiForDraft()}
                    className="duo-btn flex items-center justify-center gap-2 px-5 py-3.5 rounded-2xl bg-[#CE82FF] hover:bg-[#D799FF] border-2 border-[#A560E8] border-b-[5px] text-white text-sm font-black cursor-pointer disabled:opacity-60 whitespace-nowrap"
                  >
                    {draftAiLoading ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <Bot className="w-5 h-5" />
                    )}
                    <span>
                      {draftAiLoading ? 'جاري التحليل والحل...' : 'اعرف الحل بالـ AI'}
                    </span>
                  </button>

                  <button
                    type="submit"
                    disabled={insertingQuestion || pdfLoading}
                    className="duo-btn flex items-center justify-center gap-2.5 px-6 sm:px-8 py-3.5 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-[#46A302] border-b-[5px] text-white text-sm sm:text-base font-black cursor-pointer disabled:opacity-60 whitespace-nowrap"
                  >
                    {composerTab === 'pdf' && activePdfDoc ? (
                      <Eye className="w-5 h-5" />
                    ) : (
                      <Send className="w-5 h-5" />
                    )}
                    <span>
                      {insertingQuestion
                        ? 'جاري النشر...'
                        : composerTab === 'pdf' && activePdfDoc
                        ? `إظهار صفحة ${activePdfDoc.selectedPage} وإدراجها للجميع`
                        : 'أدرج السؤال للجميع'}
                    </span>
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Live Students Whiteboards Grid */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-black text-[#3C3C3C]">
                سبورات الطلاب المباشرة ({participants.length})
              </h3>
              <span className="text-xs font-bold text-[#777777]">
                اضغط على أي سبورة لتكبيرها ومتابعة الحل
              </span>
            </div>

            {participants.length === 0 ? (
              <div className="duo-card p-8 text-center text-sm font-bold text-[#777777]">
                لا يوجد طلاب في الغرفة حالياً. شارك رمز الغرفة{' '}
                <span className="font-latin text-[#1CB0F6] font-black">{room.id}</span>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {participants.map((p) => {
                  const board = boards.find((b) => b.studentId === p.uid);
                  const verdict = board?.verdict;
                  const submitted = board?.submitted;
                  return (
                    <div
                      key={p.uid}
                      className={`duo-card p-4 flex flex-col gap-3 ${
                        verdict === 'correct'
                          ? 'border-[#58CC02] bg-[#D7FFB8]/30'
                          : verdict === 'wrong'
                          ? 'border-[#FF4B4B] bg-[#FFDFE0]/30'
                          : submitted
                          ? 'border-[#FFC800] bg-[#FFF4CC]/30'
                          : ''
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-black text-[#3C3C3C] truncate">
                            {p.fullNameQuad}
                          </p>
                          <p className="text-xs font-bold text-[#777777]">
                            النقاط:{' '}
                            <span className="font-latin font-black text-[#1CB0F6]">
                              {p.score}
                            </span>
                            {' · '}
                            {verdict === 'correct'
                              ? 'إجابة صحيحة'
                              : verdict === 'wrong'
                              ? 'إجابة خاطئة'
                              : submitted
                              ? 'ضغط تم (بانتظار التأكيد)'
                              : board && board.strokes.length > 0
                              ? 'يكتب على السبورة الآن'
                              : 'لم يبدأ الكتابة'}
                          </p>
                        </div>

                        <button
                          type="button"
                          onClick={() =>
                            setInspectedBoard(
                              board ?? {
                                studentId: p.uid,
                                studentName: p.fullNameQuad,
                                roomId: room.id,
                                questionId: currentQuestion?.id || '',
                                strokes: [],
                                submitted: false,
                                verdict: 'pending',
                              }
                            )
                          }
                          className="p-2 rounded-xl bg-[#F7F7F7] hover:bg-[#DDF4FF] text-[#3C3C3C] hover:text-[#1899D6] cursor-pointer shrink-0"
                          title="تكبير السبورة"
                        >
                          <ZoomIn className="w-4 h-4" />
                        </button>
                      </div>

                      <WhiteboardPreview
                        strokes={board?.strokes || []}
                        backgroundImage={currentQuestion?.imageData || undefined}
                        emptyText={
                          currentQuestion ? 'لم يكتب الطالب بعد' : 'بانتظار السؤال'
                        }
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ==================== STUDENT VIEW ==================== */
        <div
          className={
            studentFullscreen
              ? 'fixed inset-0 z-40 bg-white flex flex-col gap-2.5 p-2.5 sm:p-4 overflow-y-auto'
              : 'flex flex-col gap-3 sm:gap-4'
          }
        >
          {!studentFullscreen && (
            <RoomQuizSyncBanner
              roomId={room.id}
              profile={profile}
              isSupervisor={false}
              compact
            />
          )}
          {/* Student Compact Controls Bar (Question preview + Fullscreen toggle for easy zooming) */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5]">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {currentQuestion ? (
                <>
                  <span className="font-latin px-2.5 py-0.5 rounded-lg bg-[#1CB0F6] text-white text-xs font-black shrink-0">
                    س{currentQuestion.orderIndex}
                  </span>
                  <span className="text-xs sm:text-sm font-black text-[#3C3C3C] truncate">
                    {currentQuestion.text || 'صفحة السؤال — يمكنك التكبير والتحريك بإصبعين أو بأزرار + / -'}
                  </span>
                </>
              ) : (
                <span className="text-xs sm:text-sm font-bold text-[#777777]">
                  سبورتك الشخصية للحل
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {currentQuestion &&
                currentQuestion.status === 'solving' &&
                activeTimerTotal > 0 &&
                timerRemainingSeconds !== null && (
                  <div
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-xl border-2 text-xs font-black shrink-0 ${
                      isTimeUp || timerRemainingSeconds <= 10
                        ? 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B]'
                        : 'bg-[#DDF4FF] border-[#1CB0F6] text-[#1899D6]'
                    }`}
                  >
                    <Timer className="w-3.5 h-3.5" />
                    <span className="font-latin">
                      {formatTimerClock(timerRemainingSeconds)}
                    </span>
                  </div>
                )}
              {currentQuestion?.imageData && (
                <button
                  type="button"
                  onClick={() => setZoomedImage(currentQuestion.imageData)}
                  className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#1899D6] cursor-pointer whitespace-nowrap"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                  <span>تكبير الورقة</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setStudentFullscreen((prev) => !prev)}
                className={`duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl border-2 border-b-3 text-xs font-black cursor-pointer whitespace-nowrap ${
                  studentFullscreen
                    ? 'bg-[#FFC800] border-[#E5A400] text-[#3C3C3C]'
                    : 'bg-white border-[#E5E5E5] text-[#3C3C3C]'
                }`}
              >
                {studentFullscreen ? (
                  <>
                    <Minimize2 className="w-3.5 h-3.5" />
                    <span>تصغير العرض</span>
                  </>
                ) : (
                  <>
                    <Maximize2 className="w-3.5 h-3.5" />
                    <span>ملء الشاشة</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <WhiteboardCanvas
            strokes={localStrokes}
            onStrokesChange={handleStrokesChange}
            backgroundImage={currentQuestion?.imageData || undefined}
            heightClass={
              studentFullscreen
                ? 'h-[calc(100dvh-235px)] sm:h-[calc(100dvh-205px)] min-h-[250px]'
                : currentQuestion?.imageData
                ? 'h-[310px] sm:h-[460px] md:h-[560px]'
                : undefined
            }
            disabled={studentLockedInfo.locked}
            lockTitle={studentLockedInfo.title}
            lockSubtitle={studentLockedInfo.subtitle}
          />

          {/* Student Submit ("تم") Action Bar */}
          <div className="duo-card p-3 sm:p-4 flex flex-col sm:flex-row items-center justify-between gap-3 sm:gap-4 shrink-0">
            <div className="text-xs sm:text-sm font-bold text-[#777777]">
              {!currentQuestion
                ? 'عند إدراج السؤال ستفتح سبورتك للحل فوراً.'
                : studentLockedInfo.locked
                ? studentLockedInfo.title
                : 'اكتب حلك على السبورة ثم اضغط «تم» لإرسال الإجابة للمشرف.'}
            </div>

            <button
              type="button"
              disabled={studentLockedInfo.locked || submittingBoard}
              onClick={handleStudentSubmit}
              className="duo-btn w-full sm:w-auto flex items-center justify-center gap-2.5 px-8 sm:px-10 py-3.5 sm:py-4 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-[#46A302] border-b-[5px] text-white text-base sm:text-lg font-black cursor-pointer disabled:bg-[#E5E5E5] disabled:border-[#CFCFCF] disabled:text-[#AFAFAF] disabled:cursor-not-allowed whitespace-nowrap"
            >
              <Check className="w-6 h-6 stroke-[3]" />
              <span>{submittingBoard ? 'جاري الإرسال...' : 'تم — إرسال الحل'}</span>
            </button>
          </div>
        </div>
      )}
        </>
      )}

      {/* Zoomed Question Image Modal */}
      {zoomedImage && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-2.5 sm:p-4"
          onClick={() => setZoomedImage(null)}
        >
          <div
            className="bg-white rounded-3xl p-3 sm:p-4 max-w-5xl w-full flex flex-col gap-3 max-h-[95dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center">
              <span className="font-black text-sm sm:text-base text-[#3C3C3C]">
                معاينة وتكبير الصفحة / السؤال
              </span>
              <button
                type="button"
                onClick={() => setZoomedImage(null)}
                className="p-2 rounded-xl bg-[#F7F7F7] hover:bg-[#FFDFE0] text-[#3C3C3C] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <ZoomablePreviewStage imageSrc={zoomedImage} />
          </div>
        </div>
      )}

      {/* Inspected Student Board Modal */}
      {inspectedBoard && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-2.5 sm:p-4"
          onClick={() => setInspectedBoard(null)}
        >
          <div
            className="bg-white rounded-3xl p-3.5 sm:p-5 max-w-5xl w-full flex flex-col gap-3 sm:gap-4 max-h-[95dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center">
              <h3 className="text-base sm:text-lg font-black text-[#3C3C3C] truncate">
                سبورة الطالب: {inspectedBoard.studentName}
              </h3>
              <button
                type="button"
                onClick={() => setInspectedBoard(null)}
                className="p-2 rounded-xl bg-[#F7F7F7] hover:bg-[#FFDFE0] text-[#3C3C3C] cursor-pointer shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <ZoomablePreviewStage
              imageSrc={currentQuestion?.imageData || undefined}
              strokes={inspectedBoard.strokes || []}
            />
          </div>
        </div>
      )}

      {/* Finish Test Confirmation Modal */}
      {showEndConfirm && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="duo-card max-w-md w-full p-6 flex flex-col gap-4 text-center">
            <h3 className="text-xl font-black text-[#3C3C3C]">
              هل تريد إنهاء الاختبار الآن؟
            </h3>
            <p className="text-sm font-bold text-[#777777]">
              سيتم عرض النتائج النهائية وجميع الأسئلة والصبورات للجميع، وحفظ الاختبار كاملاً في حساب كل مشرف وطالب.
            </p>
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowEndConfirm(false)}
                className="duo-btn flex-1 py-3 rounded-2xl bg-white border-2 border-b-4 border-[#E5E5E5] text-sm font-black text-[#3C3C3C] cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={finishingRoom}
                onClick={handleFinishRoom}
                className="duo-btn flex-1 py-3 rounded-2xl bg-[#FF4B4B] border-2 border-b-4 border-[#EA2B2B] text-sm font-black text-white cursor-pointer disabled:opacity-60"
              >
                {finishingRoom ? 'جاري الإنهاء...' : 'تأكيد الإنهاء'}
              </button>
            </div>
          </div>
        </div>
      )}
      <AiKeyModal
        open={aiKeyModalOpen}
        onClose={() => {
          pendingAiActionRef.current = null;
          setAiKeyModalOpen(false);
        }}
        onReady={() => {
          setAiKeyModalOpen(false);
          const next = pendingAiActionRef.current;
          pendingAiActionRef.current = null;
          if (next) setTimeout(next, 0);
        }}
      />
    </div>
  );
};
