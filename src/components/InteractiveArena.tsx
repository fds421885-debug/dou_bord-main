import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  Ban,
  BookmarkCheck,
  BookmarkPlus,
  ChevronLeft,
  ChevronRight,
  Download,
  Eraser,
  FilePlus2,
  FileText,
  Flag,
  FolderOpen,
  ImageDown,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  PenTool,
  Radio,
  RefreshCw,
  Sparkles,
  Trash2,
  Trophy,
  Unlock,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  InteractiveSlide,
  Participant,
  Room,
  RoomMode,
  SlideLayer,
  Stroke,
  UserProfile,
} from '../types';
import {
  MAX_ROOM_SLIDES,
  fetchSlideStrokeLayers,
  groupSlidesIntoFiles,
  parseUploadedFilesToBatches,
  removeSlidesAndReindex,
  renderAnnotatedSlideToDataUrl,
  saveSessionFilesToArchive,
  triggerDataUrlDownload,
  uploadSlideBatchesToRoom,
  type SlideFileGroup,
} from '../slideFiles';
import { playDuoSound } from './DuoIcons';
import { mergeActiveRoomSnapshot } from '../localDraftStore';
import { doesStrokeIntersectEraser, WhiteboardCanvas } from './WhiteboardCanvas';
import { CompetitionArena } from './CompetitionArena';

interface InteractiveArenaProps {
  room: Room;
  profile: UserProfile;
  participants: Participant[];
  isSupervisor: boolean;
}

export const InteractiveArena: React.FC<InteractiveArenaProps> = ({
  room,
  profile,
  participants,
  isSupervisor,
}) => {
  const [slides, setSlides] = useState<InteractiveSlide[]>([]);
  const [layers, setLayers] = useState<SlideLayer[]>([]);
  const syncedSlideIndex = room.currentSlideIndex ?? 0;
  const [localPageIndex, setLocalPageIndex] = useState<number>(
    syncedSlideIndex > 0 ? syncedSlideIndex : 1
  );
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Local strokes for the current user's layer on the active slide
  const [myStrokes, setMyStrokes] = useState<Stroke[]>([]);
  const lastLocalEditAtRef = useRef<number>(0);
  const createdSlideIdsRef = useRef<Set<string>>(new Set());
  const writeInFlightRef = useRef<boolean>(false);
  const pendingSaveRef = useRef<{ slideId: string; strokes: Stroke[] } | null>(null);

  // Supervisor upload & multi-file management state
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [clearingPage, setClearingPage] = useState(false);
  const [updatingEditor, setUpdatingEditor] = useState(false);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [finishingRoom, setFinishingRoom] = useState(false);

  // File removal & session saving state
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<SlideFileGroup | null>(null);
  const [confirmClearAllFiles, setConfirmClearAllFiles] = useState(false);
  const [removingFiles, setRemovingFiles] = useState(false);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [savingSession, setSavingSession] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadIntentRef = useRef<'append' | 'replaceAll' | 'replaceFile'>('replaceAll');
  const replaceTargetGroupRef = useRef<SlideFileGroup | null>(null);

  const isCompetitionMode = room.mode === 'competition';

  // Subscribe to room slides sorted by pageIndex
  useEffect(() => {
    const path = `rooms/${room.id}/slides`;
    const q = query(collection(db, 'rooms', room.id, 'slides'), where('roomId', '==', room.id));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: InteractiveSlide[] = [];
        snap.forEach((d) => list.push(d.data() as InteractiveSlide));
        list.sort((a, b) => a.pageIndex - b.pageIndex);
        setSlides(list);
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, path);
      }
    );
    return () => unsub();
  }, [room.id]);

  // Follow supervisor's synced page whenever room.currentSlideIndex updates
  useEffect(() => {
    if (syncedSlideIndex > 0) {
      setLocalPageIndex(syncedSlideIndex);
    } else if (slides.length > 0) {
      setLocalPageIndex(slides[0].pageIndex);
    }
  }, [syncedSlideIndex, slides.length]);

  const activeSlideIndexPos = useMemo(() => {
    if (slides.length === 0) return -1;
    const exactIdx = slides.findIndex((s) => s.pageIndex === localPageIndex);
    if (exactIdx >= 0) return exactIdx;
    return Math.min(Math.max(localPageIndex - 1, 0), slides.length - 1);
  }, [slides, localPageIndex]);

  const activeSlide = useMemo(() => {
    if (activeSlideIndexPos < 0 || slides.length === 0) return null;
    return slides[activeSlideIndexPos] ?? slides[0];
  }, [slides, activeSlideIndexPos]);

  const fileGroups = useMemo(() => groupSlidesIntoFiles(slides), [slides]);

  const activeFileGroup = useMemo(() => {
    if (!activeSlide || fileGroups.length === 0) return null;
    return (
      fileGroups.find((g) => g.slides.some((s) => s.id === activeSlide.id)) ??
      fileGroups[0]
    );
  }, [fileGroups, activeSlide?.id]);

  // Subscribe to all annotation layers for the currently viewed slide
  useEffect(() => {
    if (!activeSlide) {
      setLayers([]);
      setMyStrokes([]);
      return;
    }

    const slideId = activeSlide.id;
    const path = `rooms/${room.id}/slides/${slideId}/layers`;
    const q = query(
      collection(db, 'rooms', room.id, 'slides', slideId, 'layers'),
      where('roomId', '==', room.id),
      where('slideId', '==', slideId)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: SlideLayer[] = [];
        let foundMine: SlideLayer | null = null;
        snap.forEach((d) => {
          const data = d.data() as SlideLayer;
          list.push(data);
          if (data.authorId === profile.uid) {
            foundMine = data;
            createdSlideIdsRef.current.add(slideId);
          }
        });
        setLayers(list);

        if (foundMine) {
          const remoteStrokes = (foundMine as SlideLayer).strokes ?? [];
          const elapsedSinceEdit = Date.now() - lastLocalEditAtRef.current;
          if (remoteStrokes.length === 0 || elapsedSinceEdit > 1200) {
            setMyStrokes(remoteStrokes);
          }
        } else {
          createdSlideIdsRef.current.delete(slideId);
          if (Date.now() - lastLocalEditAtRef.current > 1200) {
            setMyStrokes([]);
          }
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, path);
      }
    );

    return () => unsub();
  }, [room.id, activeSlide?.id, profile.uid]);

  // Reset local buffer immediately on slide switch
  useEffect(() => {
    lastLocalEditAtRef.current = 0;
    if (!activeSlide) {
      setMyStrokes([]);
      return;
    }
    const mine = layers.find(
      (l) => l.slideId === activeSlide.id && l.authorId === profile.uid
    );
    setMyStrokes(mine?.strokes ?? []);
  }, [activeSlide?.id]);

  // Continuously mirror live interactive slides & layers to IndexedDB for database failover
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void mergeActiveRoomSnapshot(room.id, {
        room,
        participants,
        slides,
        slideLayers: layers,
        myRole: isSupervisor ? 'supervisor' : 'student',
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [room, participants, slides, layers, isSupervisor]);

  const blockedIds = room.explainBlockedIds ?? [];
  const isAmIBlocked = !isSupervisor && blockedIds.includes(profile.uid);

  const canDraw = useMemo(() => {
    if (!activeSlide) return false;
    if (isSupervisor) return true;
    if (isAmIBlocked) return false;
    return room.interactiveEditor === 'all' || room.interactiveEditor === profile.uid;
  }, [activeSlide, isSupervisor, isAmIBlocked, room.interactiveEditor, profile.uid]);

  const otherLayers = useMemo(() => {
    return layers
      .filter((l) => l.authorId !== profile.uid && (l.strokes?.length ?? 0) > 0)
      .map((l) => l.strokes);
  }, [layers, profile.uid]);

  const activeContributors = useMemo(() => {
    return layers.filter((l) => (l.strokes?.length ?? 0) > 0);
  }, [layers]);

  const writerStrokeCounts = useMemo(() => {
    const map = new Map<string, number>();
    if (myStrokes.length > 0) {
      map.set(profile.uid, myStrokes.length);
    }
    layers.forEach((l) => {
      const count = l.strokes?.length ?? 0;
      if (count > 0 && l.authorId !== profile.uid) {
        map.set(l.authorId, count);
      }
    });
    return map;
  }, [layers, myStrokes.length, profile.uid]);

  const hasOtherWritersOnPage = useMemo(
    () => layers.some((l) => l.authorId !== profile.uid && (l.strokes?.length ?? 0) > 0),
    [layers, profile.uid]
  );

  // Serialized Firestore writer so strokes never race or drop during fast drawing
  const flushSaveQueue = useCallback(async () => {
    if (writeInFlightRef.current) return;
    const nextTask = pendingSaveRef.current;
    if (!nextTask) return;

    pendingSaveRef.current = null;
    writeInFlightRef.current = true;

    const { slideId, strokes } = nextTask;
    const layerPath = `rooms/${room.id}/slides/${slideId}/layers/${profile.uid}`;
    const layerRef = doc(db, 'rooms', room.id, 'slides', slideId, 'layers', profile.uid);

    try {
      if (createdSlideIdsRef.current.has(slideId)) {
        await updateDoc(layerRef, {
          strokes,
          updatedAt: serverTimestamp(),
        });
      } else {
        createdSlideIdsRef.current.add(slideId);
        await setDoc(layerRef, {
          id: profile.uid,
          roomId: room.id,
          slideId,
          authorId: profile.uid,
          authorName: profile.fullNameQuad,
          strokes,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('NOT_FOUND') || errMsg.includes('No document to update')) {
        try {
          await setDoc(layerRef, {
            id: profile.uid,
            roomId: room.id,
            slideId,
            authorId: profile.uid,
            authorName: profile.fullNameQuad,
            strokes,
            updatedAt: serverTimestamp(),
          });
        } catch (innerErr) {
          createdSlideIdsRef.current.delete(slideId);
          handleFirestoreError(innerErr, OperationType.WRITE, layerPath);
        }
      } else {
        handleFirestoreError(err, OperationType.WRITE, layerPath);
      }
    } finally {
      writeInFlightRef.current = false;
      if (pendingSaveRef.current) {
        void flushSaveQueue();
      }
    }
  }, [room.id, profile.uid, profile.fullNameQuad]);

  const handleMyStrokesChange = (nextStrokes: Stroke[]) => {
    if (!activeSlide || !canDraw) return;
    lastLocalEditAtRef.current = Date.now();
    setMyStrokes(nextStrokes);
    pendingSaveRef.current = { slideId: activeSlide.id, strokes: nextStrokes };
    void flushSaveQueue();
  };

  const triggerFilePicker = (
    intent: 'append' | 'replaceAll' | 'replaceFile',
    targetGroup: SlideFileGroup | null = null
  ) => {
    if (!isSupervisor || uploading) return;
    uploadIntentRef.current = intent;
    replaceTargetGroupRef.current = targetGroup;
    fileInputRef.current?.click();
  };

  // Supervisor: upload one or multiple PDFs / Images (append, replace single file, or replace all)
  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked: File[] = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (picked.length === 0 || !isSupervisor) return;

    const intent = uploadIntentRef.current;
    const targetGroup = replaceTargetGroupRef.current;

    setUploadError(null);
    setSaveFeedback(null);
    setUploading(true);

    try {
      const isReplaceAll = intent === 'replaceAll' || slides.length === 0;
      const isReplaceSingleFile = intent === 'replaceFile' && Boolean(targetGroup);

      const maxRemaining = isReplaceAll
        ? MAX_ROOM_SLIDES
        : isReplaceSingleFile && targetGroup
        ? Math.max(0, MAX_ROOM_SLIDES - (slides.length - targetGroup.slides.length))
        : Math.max(0, MAX_ROOM_SLIDES - slides.length);

      if (maxRemaining <= 0) {
        setUploadError(`تم الوصول للحد الأقصى (${MAX_ROOM_SLIDES} صفحة في الجلسة). احذف ملفاً أولاً لإضافة ملفات جديدة.`);
        setUploading(false);
        return;
      }

      const { batches, totalPages, warnings } = await parseUploadedFilesToBatches(
        picked,
        maxRemaining,
        (status) => setUploadStatus(status)
      );

      if (batches.length === 0 || totalPages === 0) {
        setUploadError(
          warnings[0] || 'لم يتم العثور على ملفات PDF أو صور صالحة للعرض.'
        );
        setUploading(false);
        return;
      }

      let baselineSlides = slides;

      if (isReplaceSingleFile && targetGroup) {
        setUploadStatus(`جاري استبدال «${targetGroup.fileName}»...`);
        await removeSlidesAndReindex({
          roomId: room.id,
          allSlides: slides,
          slidesToRemove: targetGroup.slides,
          currentSlideIndex: syncedSlideIndex,
        });
        const removedSet = new Set(targetGroup.slides.map((s) => s.id));
        const remainingSorted = slides
          .filter((s) => !removedSet.has(s.id))
          .map((s, idx) => ({ ...s, pageIndex: idx + 1 }));
        baselineSlides = remainingSorted;
        targetGroup.slides.forEach((s) => createdSlideIdsRef.current.delete(s.id));
      } else if (isReplaceAll && slides.length > 0) {
        createdSlideIdsRef.current.clear();
      }

      const { firstNewPageIndex } = await uploadSlideBatchesToRoom({
        roomId: room.id,
        existingSlides: baselineSlides,
        batches,
        replaceAll: isReplaceAll,
        onProgress: (status) => setUploadStatus(status),
      });

      setLocalPageIndex(firstNewPageIndex);
      if (warnings.length > 0) {
        setUploadError(warnings.join(' · '));
      }
      playDuoSound('correct');
    } catch (err) {
      console.error(err);
      setUploadError('تعذر رفع الملفات، تأكد أن الملفات غير محمية بكلمة مرور وحاول مرة أخرى');
    } finally {
      setUploading(false);
      setUploadStatus('');
      replaceTargetGroupRef.current = null;
    }
  };

  // Navigate pages (supervisor updates synced room page; student flips locally)
  const handleGoToPage = async (targetPage: number) => {
    if (slides.length === 0) return;
    const minPage = slides[0]?.pageIndex ?? 1;
    const maxPage = slides[slides.length - 1]?.pageIndex ?? slides.length;
    const clamped = Math.max(minPage, Math.min(maxPage, targetPage));
    setLocalPageIndex(clamped);
    playDuoSound('pop');

    if (isSupervisor) {
      try {
        await updateDoc(doc(db, 'rooms', room.id), {
          currentSlideIndex: clamped,
          slideCount: slides.length,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.id}`);
      }
    }
  };

  // Remove a single file group (all its slides & layers) and re-index remaining slides cleanly
  const handleConfirmRemoveFileGroup = async (group: SlideFileGroup) => {
    if (!isSupervisor || removingFiles) return;
    setRemovingFiles(true);
    setUploadError(null);
    try {
      const { nextCurrentSlideIndex } = await removeSlidesAndReindex({
        roomId: room.id,
        allSlides: slides,
        slidesToRemove: group.slides,
        currentSlideIndex: syncedSlideIndex,
      });
      group.slides.forEach((s) => createdSlideIdsRef.current.delete(s.id));
      setLocalPageIndex(nextCurrentSlideIndex > 0 ? nextCurrentSlideIndex : 1);
      setPendingDeleteGroup(null);
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `rooms/${room.id}/slides`);
    } finally {
      setRemovingFiles(false);
    }
  };

  // Remove all uploaded files from the session cleanly
  const handleConfirmClearAllFiles = async () => {
    if (!isSupervisor || removingFiles || slides.length === 0) return;
    setRemovingFiles(true);
    setUploadError(null);
    try {
      await removeSlidesAndReindex({
        roomId: room.id,
        allSlides: slides,
        slidesToRemove: slides,
        currentSlideIndex: syncedSlideIndex,
      });
      createdSlideIdsRef.current.clear();
      setLocalPageIndex(1);
      setConfirmClearAllFiles(false);
      setPendingDeleteGroup(null);
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `rooms/${room.id}/slides`);
    } finally {
      setRemovingFiles(false);
    }
  };

  // Save session files & boards to personal archive (اختباراتي المحفوظة)
  const handleSaveSessionToArchive = async () => {
    if (savingSession || slides.length === 0) return;
    setSavingSession(true);
    setSaveFeedback(null);
    try {
      const { savedCount } = await saveSessionFilesToArchive({
        uid: profile.uid,
        room,
        participants,
        userRole: isSupervisor ? 'supervisor' : 'student',
        slides,
      });
      setSaveFeedback({
        type: 'success',
        text: `تم حفظ ${savedCount} صفحة وجميع الحلول في «اختباراتي المحفوظة» بنجاح!`,
      });
      setSaveMenuOpen(false);
      playDuoSound('correct');
    } catch (err) {
      console.error(err);
      setSaveFeedback({
        type: 'error',
        text: 'تعذر حفظ ملفات الجلسة في الحساب، يمكنك المحاولة مرة أخرى.',
      });
    } finally {
      setSavingSession(false);
    }
  };

  // Download active slide annotated as PNG
  const handleDownloadCurrentSlide = async () => {
    if (!activeSlide || savingSession) return;
    setSavingSession(true);
    setSaveFeedback(null);
    try {
      const allLayersOnPage: Stroke[][] = [];
      allLayersOnPage.push(myStrokes);
      layers.forEach((l) => {
        if (l.authorId !== profile.uid && (l.strokes?.length ?? 0) > 0) {
          allLayersOnPage.push(l.strokes);
        }
      });
      const dataUrl = await renderAnnotatedSlideToDataUrl(
        activeSlide.imageData,
        allLayersOnPage
      );
      const baseName = (activeSlide.fileName || room.id).replace(/\.[^.]+$/, '');
      const pageNum = activeSlide.filePageIndex ?? activeSlide.pageIndex;
      triggerDataUrlDownload(dataUrl, `${baseName}_p${pageNum}.png`);
      setSaveMenuOpen(false);
      setSaveFeedback({
        type: 'success',
        text: 'تم تنزيل الصفحة الحالية مع الرسومات على جهازك!',
      });
      playDuoSound('pop');
    } catch {
      setSaveFeedback({
        type: 'error',
        text: 'تعذر تجهيز صورة الصفحة للتنزيل.',
      });
    } finally {
      setSavingSession(false);
    }
  };

  // Download ALL slides with everyone's annotations sequentially
  const handleDownloadAllSlides = async () => {
    if (slides.length === 0 || savingSession) return;
    setSavingSession(true);
    setSaveFeedback(null);
    try {
      for (let i = 0; i < slides.length; i++) {
        const s = slides[i];
        const strokeLayers =
          activeSlide && s.id === activeSlide.id
            ? [
                myStrokes,
                ...layers
                  .filter((l) => l.authorId !== profile.uid)
                  .map((l) => l.strokes),
              ]
            : await fetchSlideStrokeLayers(room.id, s.id);
        const dataUrl = await renderAnnotatedSlideToDataUrl(s.imageData, strokeLayers);
        const baseName = (s.fileName || room.id).replace(/\.[^.]+$/, '');
        const pageNum = s.filePageIndex ?? s.pageIndex;
        triggerDataUrlDownload(dataUrl, `${i + 1}_${baseName}_p${pageNum}.png`);
        if (i < slides.length - 1) {
          await new Promise((res) => window.setTimeout(res, 180));
        }
      }
      setSaveMenuOpen(false);
      setSaveFeedback({
        type: 'success',
        text: `تم تنزيل جميع صفحات الجلسة (${slides.length} صورة) بالحلول والرسومات!`,
      });
      playDuoSound('correct');
    } catch {
      setSaveFeedback({
        type: 'error',
        text: 'تعذر تنزيل بعض صفحات الجلسة.',
      });
    } finally {
      setSavingSession(false);
    }
  };

  const handleSetInteractiveEditor = async (editorId: string, editorName: string) => {
    if (!isSupervisor || updatingEditor) return;
    setUpdatingEditor(true);
    try {
      const nextBlocked = blockedIds.filter((id) => id !== editorId);
      await updateDoc(doc(db, 'rooms', room.id), {
        interactiveEditor: editorId,
        interactiveEditorName: editorName,
        explainBlockedIds: nextBlocked,
        updatedAt: serverTimestamp(),
      });
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.id}`);
    } finally {
      setUpdatingEditor(false);
    }
  };

  // Supervisor: block or allow a specific student from writing in Interactive Mode
  const handleToggleBlockStudent = async (studentId: string) => {
    if (!isSupervisor || updatingEditor) return;
    setUpdatingEditor(true);
    const currentlyBlocked = blockedIds.includes(studentId);
    const nextBlocked = currentlyBlocked
      ? blockedIds.filter((id) => id !== studentId)
      : Array.from(new Set([...blockedIds, studentId]));

    try {
      if (!currentlyBlocked && room.interactiveEditor === studentId) {
        await updateDoc(doc(db, 'rooms', room.id), {
          interactiveEditor: 'supervisor',
          interactiveEditorName: profile.fullNameQuad,
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
      setUpdatingEditor(false);
    }
  };

  // Supervisor: direct Eraser sweep erases ANY student's strokes on contact
  const handleSupervisorEraserSweep = async (eraserStroke: Stroke) => {
    if (!isSupervisor || !activeSlide || !eraserStroke.isEraser) return;
    const hitRadius = Math.max(eraserStroke.width * 2.4, 24) / 2 + 8;

    try {
      const batch = writeBatch(db);
      let mutations = 0;

      for (const layer of layers) {
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
              activeSlide.id,
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

      if (mutations > 0) {
        await batch.commit();
      }
    } catch (err) {
      console.error('Supervisor eraser sweep error:', err);
    }
  };

  // Supervisor: clear a specific contributor's strokes (student or supervisor) on active slide
  const handleClearPersonStrokes = async (targetUid: string) => {
    if (!isSupervisor || !activeSlide || clearingPage) return;
    setClearingPage(true);
    try {
      if (targetUid === profile.uid) {
        lastLocalEditAtRef.current = 0;
        pendingSaveRef.current = null;
        setMyStrokes([]);
      }
      const targetLayer = layers.find((l) => l.authorId === targetUid);
      if (targetLayer) {
        await deleteDoc(
          doc(
            db,
            'rooms',
            room.id,
            'slides',
            activeSlide.id,
            'layers',
            targetLayer.id
          )
        );
        if (targetUid === profile.uid) {
          createdSlideIdsRef.current.delete(activeSlide.id);
        }
      }
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(
        err,
        OperationType.DELETE,
        `rooms/${room.id}/slides/${activeSlide.id}/layers`
      );
    } finally {
      setClearingPage(false);
    }
  };

  // Supervisor: clear ONLY other participants' writing on this page (keep supervisor strokes)
  const handleClearStudentsOnlyOnPage = async () => {
    if (!isSupervisor || !activeSlide || clearingPage) return;
    setClearingPage(true);
    try {
      const batch = writeBatch(db);
      let count = 0;
      for (const layer of layers) {
        if (layer.authorId !== profile.uid && (layer.strokes?.length ?? 0) > 0) {
          batch.delete(
            doc(db, 'rooms', room.id, 'slides', activeSlide.id, 'layers', layer.id)
          );
          count++;
        }
      }
      if (count > 0) {
        await batch.commit();
      }
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(
        err,
        OperationType.DELETE,
        `rooms/${room.id}/slides/${activeSlide.id}/layers`
      );
    } finally {
      setClearingPage(false);
    }
  };

  const handleClearAllLayersOnPage = async () => {
    if (!isSupervisor || !activeSlide || clearingPage) return;
    setClearingPage(true);
    try {
      const batch = writeBatch(db);
      for (const layer of layers) {
        if ((layer.strokes?.length ?? 0) > 0) {
          batch.update(
            doc(db, 'rooms', room.id, 'slides', activeSlide.id, 'layers', layer.id),
            {
              strokes: [],
              updatedAt: serverTimestamp(),
            }
          );
        }
      }
      await batch.commit();
      lastLocalEditAtRef.current = 0;
      pendingSaveRef.current = null;
      setMyStrokes([]);
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(
        err,
        OperationType.UPDATE,
        `rooms/${room.id}/slides/${activeSlide.id}/layers`
      );
    } finally {
      setClearingPage(false);
    }
  };

  const handleFinishSession = async () => {
    if (!isSupervisor || finishingRoom) return;
    setFinishingRoom(true);
    try {
      await updateDoc(doc(db, 'rooms', room.id), {
        status: 'finished',
        updatedAt: serverTimestamp(),
      });
      playDuoSound('correct');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.id}`);
    } finally {
      setFinishingRoom(false);
    }
  };

  const handleSwitchMode = async (nextMode: RoomMode) => {
    if (!isSupervisor || switchingMode || room.mode === nextMode) return;
    setSwitchingMode(true);
    try {
      await updateDoc(doc(db, 'rooms', room.id), {
        mode: nextMode,
        updatedAt: serverTimestamp(),
      });
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.id}`);
    } finally {
      setSwitchingMode(false);
    }
  };

  const editorStatusLabel =
    room.interactiveEditor === 'supervisor'
      ? 'المشرف فقط يكتب الآن'
      : room.interactiveEditor === 'all'
      ? 'الجميع يحل معاً بالتزامن'
      : `يكتب الآن: ${room.interactiveEditorName}`;

  const outOfSyncFromSupervisor =
    !isSupervisor &&
    slides.length > 0 &&
    syncedSlideIndex > 0 &&
    localPageIndex !== syncedSlideIndex;

  const canGoPrev = activeSlideIndexPos > 0;
  const canGoNext = activeSlideIndexPos >= 0 && activeSlideIndexPos < slides.length - 1;

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-40 bg-white flex flex-col gap-2.5 sm:gap-3 p-2.5 sm:p-4 overflow-y-auto'
          : 'max-w-[1440px] mx-auto px-2.5 sm:px-6 py-3 sm:py-5 flex flex-col gap-3 sm:gap-4'
      }
    >
      {/* Hidden multi-file input for PDFs or Images */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,image/*"
        multiple
        onChange={handleFilesSelected}
        className="hidden"
      />

      {/* Top Interactive Control Bar */}
      <div className="duo-card p-3 sm:p-4 flex flex-col gap-3 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Room & Sync Badge */}
          <div className="flex flex-wrap items-center gap-3">
            <div
              className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 text-xs font-black ${
                isCompetitionMode
                  ? 'bg-[#FFF4CC] border-[#FFC800] text-[#9A6B00]'
                  : 'bg-[#DDF4FF] border-[#1CB0F6] text-[#1899D6]'
              }`}
            >
              {isCompetitionMode ? (
                <Trophy className="w-4 h-4" />
              ) : (
                <FileText className="w-4 h-4" />
              )}
              <span>{isCompetitionMode ? 'وضع المنافسة' : 'الوضع التفاعلي'}</span>
            </div>

            <div className="flex items-center gap-2 text-xs font-extrabold text-[#777777]">
              <span>رمز الغرفة:</span>
              <span className="font-latin text-sm font-black text-[#1CB0F6]">
                {room.id}
              </span>
            </div>

            <div className="flex items-center gap-1.5 text-xs font-extrabold text-[#3C3C3C]">
              <Users className="w-4 h-4 text-[#58CC02]" />
              <span>{participants.length} طالب</span>
            </div>

            {!isCompetitionMode && (
              <div
                className={`flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-black border ${
                  room.interactiveEditor === 'all'
                    ? 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                    : room.interactiveEditor === 'supervisor'
                    ? 'bg-[#F7F7F7] border-[#E5E5E5] text-[#777777]'
                    : 'bg-[#FFF4CC] border-[#FFC800] text-[#9A6B00]'
                }`}
              >
                <Radio className="w-3.5 h-3.5" />
                <span>{editorStatusLabel}</span>
              </div>
            )}
          </div>

          {/* Right Action Buttons */}
          <div className="flex flex-wrap items-center gap-2">
            {isSupervisor && (
              <div className="flex items-center gap-1 bg-[#F7F7F7] border-2 border-[#E5E5E5] rounded-xl p-1">
                <button
                  type="button"
                  disabled={switchingMode}
                  onClick={() => void handleSwitchMode('quiz')}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-black cursor-pointer transition-all ${
                    !isCompetitionMode
                      ? 'bg-[#1CB0F6] text-white shadow-sm'
                      : 'text-[#777777] hover:text-[#3C3C3C]'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>PDF / صور</span>
                </button>
                <button
                  type="button"
                  disabled={switchingMode}
                  onClick={() => void handleSwitchMode('competition')}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-black cursor-pointer transition-all ${
                    isCompetitionMode
                      ? 'bg-[#FFC800] text-[#3C3C3C] shadow-sm'
                      : 'text-[#777777] hover:text-[#3C3C3C]'
                  }`}
                >
                  <Trophy className="w-3.5 h-3.5" />
                  <span>المنافسة</span>
                </button>
              </div>
            )}

            {isSupervisor && !isCompetitionMode && (
              <>
                <button
                  type="button"
                  disabled={uploading || removingFiles}
                  onClick={() =>
                    triggerFilePicker(slides.length > 0 ? 'append' : 'replaceAll')
                  }
                  className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-xs font-black cursor-pointer disabled:opacity-60 whitespace-nowrap"
                >
                  {slides.length > 0 ? (
                    <FilePlus2 className="w-4 h-4" />
                  ) : (
                    <Upload className="w-4 h-4" />
                  )}
                  <span>{slides.length > 0 ? 'إضافة ملفات' : 'رفع ملفات (PDF / صور)'}</span>
                </button>

                {slides.length > 0 && (
                  <button
                    type="button"
                    disabled={uploading || removingFiles}
                    onClick={() => triggerFilePicker('replaceAll')}
                    className="duo-btn flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] hover:border-[#1CB0F6] text-[#1899D6] text-xs font-black cursor-pointer disabled:opacity-60 whitespace-nowrap"
                  >
                    <Upload className="w-4 h-4" />
                    <span>استبدال الكل</span>
                  </button>
                )}

                {slides.length > 0 && (
                  <div className="relative">
                    <button
                      type="button"
                      disabled={savingSession}
                      onClick={() => setSaveMenuOpen((prev) => !prev)}
                      className="duo-btn flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#FFC800] hover:bg-[#FFD324] border-2 border-b-4 border-[#E5A400] text-[#3C3C3C] text-xs font-black cursor-pointer disabled:opacity-60 whitespace-nowrap"
                    >
                      {savingSession ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <BookmarkPlus className="w-4 h-4" />
                      )}
                      <span>حفظ ملفات الجلسة</span>
                    </button>

                    {saveMenuOpen && (
                      <div className="absolute left-0 top-full mt-2 w-64 z-30 duo-card p-2 bg-white border-2 border-[#E5E5E5] shadow-xl flex flex-col gap-1.5">
                        <button
                          type="button"
                          disabled={savingSession}
                          onClick={() => void handleSaveSessionToArchive()}
                          className="duo-btn w-full flex items-center gap-2 px-3 py-2.5 rounded-xl bg-[#D7FFB8]/65 hover:bg-[#D7FFB8] border border-[#58CC02] text-[#46A302] text-xs font-black text-right cursor-pointer"
                        >
                          <BookmarkCheck className="w-4 h-4 shrink-0" />
                          <span>حفظ الكل في «اختباراتي المحفوظة»</span>
                        </button>
                        <button
                          type="button"
                          disabled={savingSession || !activeSlide}
                          onClick={() => void handleDownloadCurrentSlide()}
                          className="duo-btn w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-[#F7F7F7] hover:bg-[#DDF4FF] border border-[#E5E5E5] text-[#3C3C3C] text-xs font-black text-right cursor-pointer"
                        >
                          <ImageDown className="w-4 h-4 text-[#1CB0F6] shrink-0" />
                          <span>تنزيل الصفحة الحالية (PNG)</span>
                        </button>
                        <button
                          type="button"
                          disabled={savingSession || slides.length === 0}
                          onClick={() => void handleDownloadAllSlides()}
                          className="duo-btn w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-[#F7F7F7] hover:bg-[#DDF4FF] border border-[#E5E5E5] text-[#3C3C3C] text-xs font-black text-right cursor-pointer"
                        >
                          <Download className="w-4 h-4 text-[#1899D6] shrink-0" />
                          <span>تنزيل جميع الصفحات ({slides.length} صورة)</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {activeSlide && activeContributors.length > 0 && (
                  <button
                    type="button"
                    disabled={clearingPage}
                    onClick={handleClearAllLayersOnPage}
                    className="duo-btn flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] hover:border-[#FF4B4B] hover:bg-[#FFDFE0] text-[#EA2B2B] text-xs font-black cursor-pointer disabled:opacity-50 whitespace-nowrap"
                  >
                    <Eraser className="w-4 h-4" />
                    <span>مسح كل الحلول بالصفحة</span>
                  </button>
                )}
              </>
            )}

            {!isSupervisor && !isCompetitionMode && activeSlide && (
              <button
                type="button"
                disabled={savingSession}
                onClick={() => void handleDownloadCurrentSlide()}
                className="duo-btn flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#DDF4FF] border-2 border-b-4 border-[#1CB0F6] text-[#1899D6] text-xs font-black cursor-pointer disabled:opacity-60 whitespace-nowrap"
              >
                <Download className="w-4 h-4" />
                <span>حفظ الصفحة</span>
              </button>
            )}

            {!isCompetitionMode && (
              <button
                type="button"
                onClick={() => setIsFullscreen((prev) => !prev)}
                className="duo-btn flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#F7F7F7] border-2 border-b-4 border-[#E5E5E5] hover:bg-white text-[#3C3C3C] text-xs font-black cursor-pointer whitespace-nowrap"
              >
                {isFullscreen ? (
                  <>
                    <Minimize2 className="w-4 h-4" />
                    <span>تصغير العرض</span>
                  </>
                ) : (
                  <>
                    <Maximize2 className="w-4 h-4" />
                    <span>ملء الشاشة</span>
                  </>
                )}
              </button>
            )}

            {isSupervisor && (
              <button
                type="button"
                onClick={() => setShowEndConfirm(true)}
                className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#FF4B4B] hover:bg-[#FF6161] border-2 border-b-4 border-[#EA2B2B] text-white text-xs font-black cursor-pointer whitespace-nowrap"
              >
                <Flag className="w-4 h-4" />
                <span>إنهاء الجلسة</span>
              </button>
            )}
          </div>
        </div>

        {/* Supervisor Collaborative Permission & Moderation Panel */}
        {isSupervisor && !isCompetitionMode && slides.length > 0 && (
          <div className="pt-2.5 border-t-2 border-[#F0F0F0] flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-black text-[#3C3C3C] shrink-0">
                  التحكم بالكتابة ومسح خطوط الآخرين:
                </span>

                <button
                  type="button"
                  disabled={updatingEditor}
                  onClick={() => handleSetInteractiveEditor('supervisor', profile.fullNameQuad)}
                  className={`duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl border-2 border-b-3 text-xs font-black cursor-pointer shrink-0 ${
                    room.interactiveEditor === 'supervisor'
                      ? 'bg-[#3C3C3C] border-[#1F2937] text-white'
                      : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#3C3C3C]'
                  }`}
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>المشرف فقط</span>
                </button>

                <button
                  type="button"
                  disabled={updatingEditor}
                  onClick={() => handleSetInteractiveEditor('all', 'الجميع')}
                  className={`duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl border-2 border-b-3 text-xs font-black cursor-pointer shrink-0 ${
                    room.interactiveEditor === 'all'
                      ? 'bg-[#58CC02] border-[#46A302] text-white'
                      : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#3C3C3C]'
                  }`}
                >
                  <Users className="w-3.5 h-3.5" />
                  <span>الجميع يكتب معاً</span>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {hasOtherWritersOnPage && (
                  <button
                    type="button"
                    disabled={clearingPage}
                    onClick={() => void handleClearStudentsOnlyOnPage()}
                    className="duo-btn flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-[#FFDFE0]/70 border-2 border-[#FF4B4B] text-[11px] font-black text-[#EA2B2B] hover:bg-[#FFDFE0] cursor-pointer disabled:opacity-50"
                  >
                    <Eraser className="w-3.5 h-3.5" />
                    <span>مسح كتابات الطلاب فقط</span>
                  </button>
                )}

                {myStrokes.length > 0 && (
                  <button
                    type="button"
                    disabled={clearingPage}
                    onClick={() => void handleClearPersonStrokes(profile.uid)}
                    className="duo-btn flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-white border-2 border-[#E5E5E5] text-[11px] font-black text-[#EA2B2B] hover:bg-[#FFDFE0] cursor-pointer disabled:opacity-50"
                  >
                    <Eraser className="w-3.5 h-3.5" />
                    <span>مسح خط المشرف</span>
                  </button>
                )}
              </div>
            </div>

            {participants.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                {participants.map((p) => {
                  const selected = room.interactiveEditor === p.uid;
                  const isBlocked = blockedIds.includes(p.uid);
                  const strokeCount = writerStrokeCounts.get(p.uid) ?? 0;

                  return (
                    <div
                      key={p.uid}
                      className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-xl border-2 bg-white ${
                        isBlocked
                          ? 'border-[#FF4B4B]/60 bg-[#FFDFE0]/25'
                          : selected
                          ? 'border-[#FFC800] bg-[#FFF4CC]/35'
                          : 'border-[#E5E5E5]'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-xs font-black text-[#3C3C3C] truncate max-w-[140px]">
                          {p.fullNameQuad}
                        </span>
                        {strokeCount > 0 && (
                          <span className="font-latin px-1.5 py-0.5 rounded-md bg-[#DDF4FF] text-[#1899D6] text-[10px] font-black shrink-0">
                            {strokeCount} خط
                          </span>
                        )}
                        {isBlocked && (
                          <span className="px-1.5 py-0.5 rounded-md bg-[#FFDFE0] text-[#EA2B2B] text-[10px] font-black shrink-0">
                            ممنوع
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          disabled={updatingEditor}
                          onClick={() => void handleToggleBlockStudent(p.uid)}
                          title={isBlocked ? 'إتاحة الكتابة له' : 'منعه من الكتابة'}
                          className={`duo-btn flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-black cursor-pointer ${
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
                              <span>منع</span>
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          disabled={updatingEditor}
                          onClick={() =>
                            void handleSetInteractiveEditor(p.uid, p.fullNameQuad)
                          }
                          className={`duo-btn flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-black cursor-pointer ${
                            selected
                              ? 'bg-[#FFC800] border-[#E5A400] text-[#3C3C3C]'
                              : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#3C3C3C] hover:bg-[#FFF4CC]'
                          }`}
                        >
                          <PenTool className="w-3 h-3" />
                          <span>{selected ? 'يكتب الآن' : 'القلم له'}</span>
                        </button>

                        <button
                          type="button"
                          disabled={clearingPage || strokeCount === 0}
                          onClick={() => void handleClearPersonStrokes(p.uid)}
                          title="مسح ما كتبه هذا الطالب"
                          className="duo-btn flex items-center gap-1 px-2 py-1 rounded-lg border border-[#E5E5E5] bg-white text-[11px] font-black text-[#EA2B2B] hover:bg-[#FFDFE0] cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
                        >
                          <Eraser className="w-3 h-3" />
                          <span>مسح</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Upload / Removal progress / Save feedback banners */}
        {(uploading || removingFiles) && (
          <div className="p-3 rounded-xl bg-[#DDF4FF] border-2 border-[#1CB0F6] text-[#1899D6] text-xs font-black flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            <span>{uploadStatus || 'جاري تحديث ملفات الجلسة...'}</span>
          </div>
        )}
        {uploadError && (
          <div className="p-3 rounded-xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-[#EA2B2B] text-xs font-black flex items-center justify-between gap-2">
            <span>{uploadError}</span>
            <button
              type="button"
              onClick={() => setUploadError(null)}
              className="text-[#EA2B2B] hover:opacity-75 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        {saveFeedback && (
          <div
            className={`p-3 rounded-xl border-2 text-xs font-black flex items-center justify-between gap-2 ${
              saveFeedback.type === 'success'
                ? 'bg-[#D7FFB8] border-[#58CC02] text-[#46A302]'
                : 'bg-[#FFDFE0] border-[#FF4B4B] text-[#EA2B2B]'
            }`}
          >
            <span>{saveFeedback.text}</span>
            <button
              type="button"
              onClick={() => setSaveFeedback(null)}
              className="cursor-pointer hover:opacity-75"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* Competition Mode OR Main Slide + Collaborative Whiteboard Area */}
      {isCompetitionMode ? (
        <CompetitionArena
          room={room}
          profile={profile}
          participants={participants}
          isSupervisor={isSupervisor}
          onSwitchToSlides={() => void handleSwitchMode('quiz')}
        />
      ) : slides.length === 0 ? (
        <div className="duo-card p-10 sm:p-16 flex flex-col items-center justify-center text-center gap-5 min-h-[460px]">
          {isSupervisor ? (
            <>
              <div className="w-20 h-20 rounded-3xl bg-[#DDF4FF] border-2 border-[#1CB0F6] flex items-center justify-center">
                <Upload className="w-10 h-10 text-[#1899D6]" />
              </div>
              <div className="max-w-lg flex flex-col gap-2">
                <h2 className="text-2xl font-black text-[#3C3C3C]">
                  ارفع ملفاً أو أكثر (PDF أو صور) ليملأ الشاشة للجميع
                </h2>
                <p className="text-sm font-bold text-[#777777]">
                  يمكنك تحديد أكثر من ملف في وقت واحد، والتنقل وتبديل الملفات أثناء الجلسة بحرية، أو الانتقال مباشرة إلى «وضع المنافسة»!
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => triggerFilePicker('replaceAll')}
                  className="duo-btn flex items-center gap-2.5 px-8 py-4 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-[5px] border-[#46A302] text-white text-lg font-black cursor-pointer disabled:opacity-60"
                >
                  <Upload className="w-5 h-5" />
                  <span>{uploading ? 'جاري الرفع...' : 'اختيار ملفات PDF أو صور'}</span>
                </button>
                <button
                  type="button"
                  disabled={switchingMode}
                  onClick={() => void handleSwitchMode('competition')}
                  className="duo-btn flex items-center gap-2 px-7 py-4 rounded-2xl bg-[#FFC800] hover:bg-[#FFD633] border-2 border-b-[5px] border-[#E5A400] text-[#3C3C3C] text-lg font-black cursor-pointer disabled:opacity-60"
                >
                  <Trophy className="w-5 h-5" />
                  <span>بدء وضع المنافسة</span>
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="w-20 h-20 rounded-3xl bg-[#D7FFB8] border-2 border-[#58CC02] flex items-center justify-center">
                <Sparkles className="w-10 h-10 text-[#46A302]" />
              </div>
              <div className="max-w-md flex flex-col gap-2">
                <h2 className="text-2xl font-black text-[#3C3C3C]">
                  بدأت الجلسة التفاعلية!
                </h2>
                <p className="text-sm font-bold text-[#777777]">
                  يقوم المشرف الآن برفع ملفات الجلسة، وستظهر أمامك وتملأ الشاشة فور رفعها.
                </p>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="duo-card p-3 sm:p-4 flex flex-col gap-3">
          {/* Multi-File Switcher Strip */}
          <div className="flex flex-col gap-2 pb-2.5 border-b-2 border-[#F0F0F0]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-black text-[#3C3C3C]">
                <FolderOpen className="w-4 h-4 text-[#1CB0F6]" />
                <span>ملفات الجلسة ({fileGroups.length})</span>
                <span className="font-latin text-[11px] text-[#777777]">
                  · إجمالي {slides.length} صفحة
                </span>
              </div>

              {isSupervisor && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {activeFileGroup && (
                    <button
                      type="button"
                      disabled={uploading || removingFiles}
                      onClick={() => triggerFilePicker('replaceFile', activeFileGroup)}
                      title="استبدال الملف المعروض حالياً بملف آخر"
                      className="duo-btn flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#DDF4FF] hover:bg-[#C6ECFF] border border-[#1CB0F6] text-[#1899D6] text-[11px] font-black cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>تغيير هذا الملف</span>
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={uploading || removingFiles}
                    onClick={() => triggerFilePicker('append')}
                    className="duo-btn flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#D7FFB8] hover:bg-[#C3F79E] border border-[#58CC02] text-[#46A302] text-[11px] font-black cursor-pointer disabled:opacity-50"
                  >
                    <FilePlus2 className="w-3.5 h-3.5" />
                    <span>إضافة ملف</span>
                  </button>

                  {!confirmClearAllFiles ? (
                    <button
                      type="button"
                      disabled={uploading || removingFiles}
                      onClick={() => setConfirmClearAllFiles(true)}
                      className="duo-btn flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white hover:bg-[#FFDFE0] border border-[#E5E5E5] text-[#EA2B2B] text-[11px] font-black cursor-pointer disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>إزالة كل الملفات</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-1 bg-[#FFDFE0] border border-[#FF4B4B] rounded-lg px-2 py-0.5">
                      <span className="text-[11px] font-black text-[#EA2B2B]">إزالة الكل؟</span>
                      <button
                        type="button"
                        disabled={removingFiles}
                        onClick={() => void handleConfirmClearAllFiles()}
                        className="px-2 py-0.5 rounded bg-[#EA2B2B] text-white text-[10px] font-black cursor-pointer"
                      >
                        نعم
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmClearAllFiles(false)}
                        className="px-2 py-0.5 rounded bg-white text-[#3C3C3C] text-[10px] font-black cursor-pointer"
                      >
                        إلغاء
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* File Tabs */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {fileGroups.map((group) => {
                const isGroupActive = activeFileGroup?.fileId === group.fileId;
                return (
                  <div
                    key={group.fileId}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border-2 border-b-3 shrink-0 transition-all ${
                      isGroupActive
                        ? 'bg-[#1CB0F6] border-[#1899D6] text-white'
                        : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#3C3C3C] hover:bg-white'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => void handleGoToPage(group.startPageIndex)}
                      className="flex items-center gap-1.5 text-xs font-black cursor-pointer"
                    >
                      <FileText className="w-3.5 h-3.5 shrink-0" />
                      <span className="max-w-[160px] truncate">{group.fileName}</span>
                      <span
                        className={`font-latin px-1.5 py-0.5 rounded-md text-[10px] font-black ${
                          isGroupActive
                            ? 'bg-white/25 text-white'
                            : 'bg-white text-[#777777] border border-[#E5E5E5]'
                        }`}
                      >
                        {group.slides.length} ص
                      </span>
                    </button>

                    {isSupervisor && (
                      <button
                        type="button"
                        disabled={removingFiles || uploading}
                        onClick={() => setPendingDeleteGroup(group)}
                        title={`إزالة «${group.fileName}»`}
                        className={`p-0.5 rounded-md cursor-pointer transition-colors ${
                          isGroupActive
                            ? 'hover:bg-white/25 text-white'
                            : 'hover:bg-[#FFDFE0] text-[#EA2B2B]'
                        }`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Inline Single-File Removal Confirmation */}
            {isSupervisor && pendingDeleteGroup && (
              <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl bg-[#FFDFE0]/70 border-2 border-[#FF4B4B]">
                <span className="text-xs font-black text-[#EA2B2B]">
                  هل تريد إزالة الملف «{pendingDeleteGroup.fileName}» ({pendingDeleteGroup.slides.length} صفحة) مع رسوماته؟
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={removingFiles}
                    onClick={() => void handleConfirmRemoveFileGroup(pendingDeleteGroup)}
                    className="duo-btn px-3 py-1 rounded-lg bg-[#EA2B2B] text-white text-xs font-black cursor-pointer disabled:opacity-50"
                  >
                    {removingFiles ? 'جاري الإزالة...' : 'نعم، إزالة الملف'}
                  </button>
                  <button
                    type="button"
                    disabled={removingFiles}
                    onClick={() => setPendingDeleteGroup(null)}
                    className="duo-btn px-3 py-1 rounded-lg bg-white border border-[#E5E5E5] text-[#3C3C3C] text-xs font-black cursor-pointer"
                  >
                    إلغاء
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Page Navigation Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b-2 border-[#F0F0F0]">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!canGoPrev}
                onClick={() => {
                  const prevSlide = slides[activeSlideIndexPos - 1];
                  if (prevSlide) void handleGoToPage(prevSlide.pageIndex);
                }}
                className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] hover:bg-[#F7F7F7] cursor-pointer disabled:opacity-40"
              >
                <ChevronRight className="w-4 h-4" />
                <span>السابقة</span>
              </button>

              <span className="font-latin px-3 py-1 rounded-xl bg-[#F7F7F7] border border-[#E5E5E5] text-xs font-black text-[#3C3C3C]">
                {activeFileGroup && fileGroups.length > 1
                  ? `${activeSlide?.filePageIndex ?? 1} / ${activeFileGroup.slides.length} (الكل ${activeSlideIndexPos + 1}/${slides.length})`
                  : `صفحة ${activeSlideIndexPos + 1} / ${slides.length}`}
              </span>

              <button
                type="button"
                disabled={!canGoNext}
                onClick={() => {
                  const nextSlide = slides[activeSlideIndexPos + 1];
                  if (nextSlide) void handleGoToPage(nextSlide.pageIndex);
                }}
                className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] hover:bg-[#F7F7F7] cursor-pointer disabled:opacity-40"
              >
                <span>التالية</span>
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>

            {/* Quick Page Numbers for the Active File */}
            {activeFileGroup && activeFileGroup.slides.length > 1 && (
              <div className="flex items-center gap-1.5 overflow-x-auto max-w-full py-1">
                {activeFileGroup.slides.map((s, idx) => {
                  const isActive = s.id === activeSlide?.id;
                  const isSupervisorHere = room.currentSlideIndex === s.pageIndex;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => void handleGoToPage(s.pageIndex)}
                      className={`font-latin min-w-[32px] h-8 px-2 rounded-lg text-xs font-black transition-all cursor-pointer shrink-0 ${
                        isActive
                          ? 'bg-[#1CB0F6] text-white border-2 border-[#1899D6]'
                          : isSupervisorHere
                          ? 'bg-[#D7FFB8] text-[#46A302] border-2 border-[#58CC02]'
                          : 'bg-[#F7F7F7] text-[#777777] border border-[#E5E5E5] hover:bg-white'
                      }`}
                    >
                      {s.filePageIndex ?? idx + 1}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Return to supervisor page notice OR active writers hint */}
            {outOfSyncFromSupervisor ? (
              <button
                type="button"
                onClick={() => setLocalPageIndex(syncedSlideIndex)}
                className="duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#FFC800] border-2 border-b-3 border-[#E5A400] text-[#3C3C3C] text-xs font-black cursor-pointer animate-pulse"
              >
                <Radio className="w-3.5 h-3.5" />
                <span>المشرف في صفحة {syncedSlideIndex} — العودة للمشرف</span>
              </button>
            ) : (
              <div className="flex items-center gap-2 text-xs font-bold text-[#777777]">
                {isAmIBlocked ? (
                  <span className="text-[#EA2B2B] font-black flex items-center gap-1">
                    <Lock className="w-3.5 h-3.5" />
                    <span>أوقف المشرف الكتابة عنك مؤقتاً — يمكنك المشاهدة والتكبير</span>
                  </span>
                ) : canDraw ? (
                  <span className="text-[#46A302] font-black">
                    يمكنك الكتابة والحل مباشرة فوق الصفحة
                  </span>
                ) : (
                  <span>وضع المشاهدة — يمكنك التكبير أو تقليب الصفحات</span>
                )}
              </div>
            )}
          </div>

          {/* Full-screen-filling Interactive Whiteboard with PDF/Image Layer */}
          <WhiteboardCanvas
            strokes={myStrokes}
            onStrokesChange={handleMyStrokesChange}
            onEraserSweep={
              isSupervisor
                ? (eraserStroke) => void handleSupervisorEraserSweep(eraserStroke)
                : undefined
            }
            backgroundImage={activeSlide?.imageData}
            overlayStrokeLayers={otherLayers}
            viewOnly={!canDraw}
            viewOnlyLabel={
              isAmIBlocked
                ? 'أوقف المشرف الكتابة عنك مؤقتاً — يمكنك المشاهدة والتكبير فقط'
                : 'وضع المشاهدة — يمكنك التكبير أو تقليب الصفحات لمتابعة الحل'
            }
            syncIntervalMs={240}
            heightClass={
              isFullscreen
                ? 'h-[calc(100dvh-265px)] sm:h-[calc(100dvh-235px)] min-h-[240px]'
                : 'h-[48dvh] min-h-[240px] sm:h-[64dvh] md:h-[72dvh]'
            }
          />

          {/* Active Contributors on this page (with Supervisor quick-erase per person) */}
          {activeContributors.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-1 text-xs font-bold text-[#777777]">
              <span>المشاركون بالكتابة في هذه الصفحة:</span>
              {activeContributors.map((layer) => (
                <span
                  key={layer.id}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#F7F7F7] border border-[#E5E5E5] text-[#3C3C3C] font-extrabold"
                >
                  <span>{layer.authorName}</span>
                  <span className="font-latin text-[10px] text-[#1899D6]">
                    ({layer.strokes?.length ?? 0})
                  </span>
                  {isSupervisor && (
                    <button
                      type="button"
                      disabled={clearingPage}
                      onClick={() => void handleClearPersonStrokes(layer.authorId)}
                      title={`مسح كتابة ${layer.authorName}`}
                      className="text-[#EA2B2B] hover:bg-[#FFDFE0] rounded p-0.5 cursor-pointer disabled:opacity-40"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* End Session Confirmation Modal */}
      {showEndConfirm && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="duo-card max-w-md w-full p-6 flex flex-col gap-4 text-center">
            <h3 className="text-xl font-black text-[#3C3C3C]">
              إنهاء الجلسة التفاعلية؟
            </h3>
            <p className="text-sm font-bold text-[#777777]">
              سيتم حفظ جميع الصفحات والحلول المكتوبة عليها في حسابك وحسابات الطلاب والانتقال لصفحة الملخص.
            </p>
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowEndConfirm(false)}
                className="duo-btn flex-1 py-3 rounded-2xl bg-white border-2 border-b-4 border-[#E5E5E5] text-sm font-black text-[#3C3C3C] cursor-pointer"
              >
                متابعة الجلسة
              </button>
              <button
                type="button"
                disabled={finishingRoom}
                onClick={handleFinishSession}
                className="duo-btn flex-1 py-3 rounded-2xl bg-[#FF4B4B] border-2 border-b-4 border-[#EA2B2B] text-sm font-black text-white cursor-pointer disabled:opacity-60"
              >
                {finishingRoom ? 'جاري الإنهاء...' : 'نعم، إنهاء الجلسة'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
