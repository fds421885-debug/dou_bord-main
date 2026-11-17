import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
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
  ChevronLeft,
  ChevronRight,
  Eraser,
  FilePlus2,
  FileText,
  Flag,
  Lock,
  Maximize2,
  Minimize2,
  PenTool,
  Radio,
  Sparkles,
  Trophy,
  Upload,
  Users,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { compressSlideImageToDataUrl, renderPdfToSlideImages } from '../pdfUtils';
import type {
  InteractiveSlide,
  Participant,
  Room,
  RoomMode,
  SlideLayer,
  Stroke,
  UserProfile,
} from '../types';
import { playDuoSound } from './DuoIcons';
import { mergeActiveRoomSnapshot } from '../localDraftStore';
import { WhiteboardCanvas } from './WhiteboardCanvas';
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

  // Supervisor upload & session controls
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [clearingPage, setClearingPage] = useState(false);
  const [updatingEditor, setUpdatingEditor] = useState(false);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [finishingRoom, setFinishingRoom] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const appendModeRef = useRef<boolean>(false);

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

  const activeSlide = useMemo(() => {
    if (slides.length === 0) return null;
    return (
      slides.find((s) => s.pageIndex === localPageIndex) ??
      slides[Math.min(Math.max(localPageIndex - 1, 0), slides.length - 1)] ??
      slides[0]
    );
  }, [slides, localPageIndex]);

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

  const canDraw = useMemo(() => {
    if (!activeSlide) return false;
    if (isSupervisor) return true;
    return room.interactiveEditor === 'all' || room.interactiveEditor === profile.uid;
  }, [activeSlide, isSupervisor, room.interactiveEditor, profile.uid]);

  const otherLayers = useMemo(() => {
    return layers
      .filter((l) => l.authorId !== profile.uid && (l.strokes?.length ?? 0) > 0)
      .map((l) => l.strokes);
  }, [layers, profile.uid]);

  const activeContributors = useMemo(() => {
    return layers.filter((l) => (l.strokes?.length ?? 0) > 0);
  }, [layers]);

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
      // Fallback: if updateDoc failed because doc wasn't created yet, try setDoc once
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

  // Supervisor: upload PDF or Image (replace or append pages)
  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !isSupervisor) return;

    setUploadError(null);
    setUploading(true);
    const shouldAppend = appendModeRef.current && slides.length > 0;

    try {
      let newImages: string[] = [];
      const isPdf =
        file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

      if (isPdf) {
        setUploadStatus('جاري قراءة صفحات ملف PDF...');
        newImages = await renderPdfToSlideImages(
          file,
          (done, total) => {
            setUploadStatus(`جاري تجهيز الصفحة ${done} من ${total}...`);
          },
          25
        );
      } else if (file.type.startsWith('image/')) {
        setUploadStatus('جاري تجهيز الصورة...');
        const imgUrl = await compressSlideImageToDataUrl(file);
        newImages = [imgUrl];
      } else {
        setUploadError('يرجى اختيار ملف PDF أو صورة صالحة (PNG / JPG)');
        setUploading(false);
        return;
      }

      if (newImages.length === 0) {
        setUploadError('لم يتم العثور على صفحات قابلة للعرض في هذا الملف');
        setUploading(false);
        return;
      }

      const maxAllowed = shouldAppend ? Math.max(0, 100 - slides.length) : 100;
      const slicedImages = newImages.slice(0, maxAllowed);
      if (slicedImages.length === 0) {
        setUploadError('تم الوصول للحد الأقصى (100 صفحة في الجلسة)');
        setUploading(false);
        return;
      }

      // If replacing, delete existing slides and their layers first
      if (!shouldAppend && slides.length > 0) {
        setUploadStatus('جاري استبدال الصفحات السابقة...');
        for (const oldSlide of slides) {
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
        createdSlideIdsRef.current.clear();
      }

      const startIndex = shouldAppend
        ? Math.max(...slides.map((s) => s.pageIndex), 0) + 1
        : 1;
      const batchStamp = Date.now();

      // Upload in chunks of 5 slides per batch to stay comfortably inside Firestore limits
      const CHUNK_SIZE = 5;
      for (let i = 0; i < slicedImages.length; i += CHUNK_SIZE) {
        const chunk = slicedImages.slice(i, i + CHUNK_SIZE);
        setUploadStatus(
          `جاري رفع الصفحات (${Math.min(i + chunk.length, slicedImages.length)} / ${slicedImages.length})...`
        );
        const batch = writeBatch(db);
        chunk.forEach((imgData, offset) => {
          const pageIndex = startIndex + i + offset;
          const slideId = `s_${batchStamp}_${pageIndex}`;
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

      const nextCount = shouldAppend ? slides.length + slicedImages.length : slicedImages.length;
      const targetPage = shouldAppend ? startIndex : 1;

      await updateDoc(doc(db, 'rooms', room.id), {
        currentSlideIndex: targetPage,
        slideCount: nextCount,
        updatedAt: serverTimestamp(),
      });

      setLocalPageIndex(targetPage);
      playDuoSound('correct');
    } catch (err) {
      console.error(err);
      setUploadError('تعذر رفع الملف، تأكد من أن الملف غير محمي بكلمة مرور وحاول مرة أخرى');
    } finally {
      setUploading(false);
      setUploadStatus('');
    }
  };

  // Navigate pages (supervisor updates synced room page; student flips locally)
  const handleGoToPage = async (targetPage: number) => {
    if (slides.length === 0) return;
    const clamped = Math.max(1, Math.min(slides.length, targetPage));
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

  const handleSetInteractiveEditor = async (editorId: string, editorName: string) => {
    if (!isSupervisor || updatingEditor) return;
    setUpdatingEditor(true);
    try {
      await updateDoc(doc(db, 'rooms', room.id), {
        interactiveEditor: editorId,
        interactiveEditorName: editorName,
        updatedAt: serverTimestamp(),
      });
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.id}`);
    } finally {
      setUpdatingEditor(false);
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

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-40 bg-white flex flex-col gap-2.5 sm:gap-3 p-2.5 sm:p-4 overflow-y-auto'
          : 'max-w-[1440px] mx-auto px-2.5 sm:px-6 py-3 sm:py-5 flex flex-col gap-3 sm:gap-4'
      }
    >
      {/* Hidden file input for PDF or Images */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,image/*"
        onChange={handleFileSelected}
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
                  disabled={uploading}
                  onClick={() => {
                    appendModeRef.current = false;
                    fileInputRef.current?.click();
                  }}
                  className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-b-4 border-[#1899D6] text-white text-xs font-black cursor-pointer disabled:opacity-60 whitespace-nowrap"
                >
                  <Upload className="w-4 h-4" />
                  <span>{slides.length > 0 ? 'رفع PDF / صورة جديدة' : 'رفع PDF أو صورة'}</span>
                </button>

                {slides.length > 0 && (
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => {
                      appendModeRef.current = true;
                      fileInputRef.current?.click();
                    }}
                    className="duo-btn flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] hover:border-[#1CB0F6] text-[#1899D6] text-xs font-black cursor-pointer disabled:opacity-60 whitespace-nowrap"
                  >
                    <FilePlus2 className="w-4 h-4" />
                    <span>إضافة صفحة</span>
                  </button>
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

        {/* Supervisor Collaborative Permission Selector */}
        {isSupervisor && !isCompetitionMode && slides.length > 0 && (
          <div className="pt-2.5 border-t-2 border-[#F0F0F0] flex flex-nowrap sm:flex-wrap items-center gap-2 overflow-x-auto pb-1 sm:pb-0">
            <span className="text-xs font-black text-[#3C3C3C] ml-1 shrink-0">
              من يكتب الآن:
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
              <span>الجميع يحل معاً</span>
            </button>

            {participants.map((p) => {
              const selected = room.interactiveEditor === p.uid;
              return (
                <button
                  key={p.uid}
                  type="button"
                  disabled={updatingEditor}
                  onClick={() => handleSetInteractiveEditor(p.uid, p.fullNameQuad)}
                  className={`duo-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl border-2 border-b-3 text-xs font-black cursor-pointer shrink-0 ${
                    selected
                      ? 'bg-[#FFC800] border-[#E5A400] text-[#3C3C3C]'
                      : 'bg-white border-[#E5E5E5] text-[#777777] hover:text-[#3C3C3C]'
                  }`}
                >
                  <PenTool className="w-3.5 h-3.5" />
                  <span className="max-w-[140px] truncate">{p.fullNameQuad}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Upload progress / error */}
        {uploading && (
          <div className="p-3 rounded-xl bg-[#DDF4FF] border-2 border-[#1CB0F6] text-[#1899D6] text-xs font-black">
            {uploadStatus || 'جاري تجهيز الملف...'}
          </div>
        )}
        {uploadError && (
          <div className="p-3 rounded-xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-[#EA2B2B] text-xs font-black">
            {uploadError}
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
                  ارفع ملف PDF أو صورة ليملأ الشاشة للجميع
                </h2>
                <p className="text-sm font-bold text-[#777777]">
                  بعد الرفع ستظهر الصفحات فوراً بالتزامن عند جميع الطلاب، أو يمكنك التبديل مباشرة إلى «وضع المنافسة» لعمل تحدٍ من اختباراتك واختبارات الطلاب!
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => {
                    appendModeRef.current = false;
                    fileInputRef.current?.click();
                  }}
                  className="duo-btn flex items-center gap-2.5 px-8 py-4 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-[5px] border-[#46A302] text-white text-lg font-black cursor-pointer disabled:opacity-60"
                >
                  <Upload className="w-5 h-5" />
                  <span>{uploading ? 'جاري الرفع...' : 'اختيار ملف PDF أو صورة'}</span>
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
                  يقوم المشرف الآن برفع ملف الـ PDF أو الصورة التفاعلية، وسيظهر أمامك ويملأ الشاشة فور رفعه.
                </p>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="duo-card p-3 sm:p-4 flex flex-col gap-3">
          {/* Page Navigation Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b-2 border-[#F0F0F0]">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={localPageIndex <= 1}
                onClick={() => handleGoToPage(localPageIndex - 1)}
                className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] hover:bg-[#F7F7F7] cursor-pointer disabled:opacity-40"
              >
                <ChevronRight className="w-4 h-4" />
                <span>السابقة</span>
              </button>

              <span className="font-latin px-3 py-1 rounded-xl bg-[#F7F7F7] border border-[#E5E5E5] text-xs font-black text-[#3C3C3C]">
                صفحة {localPageIndex} / {slides.length}
              </span>

              <button
                type="button"
                disabled={localPageIndex >= slides.length}
                onClick={() => handleGoToPage(localPageIndex + 1)}
                className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] hover:bg-[#F7F7F7] cursor-pointer disabled:opacity-40"
              >
                <span>التالية</span>
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>

            {/* Quick Page Numbers */}
            {slides.length > 1 && (
              <div className="flex items-center gap-1.5 overflow-x-auto max-w-full py-1">
                {slides.map((s) => {
                  const isActive = s.pageIndex === localPageIndex;
                  const isSupervisorHere = room.currentSlideIndex === s.pageIndex;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => handleGoToPage(s.pageIndex)}
                      className={`font-latin min-w-[32px] h-8 px-2 rounded-lg text-xs font-black transition-all cursor-pointer shrink-0 ${
                        isActive
                          ? 'bg-[#1CB0F6] text-white border-2 border-[#1899D6]'
                          : isSupervisorHere
                          ? 'bg-[#D7FFB8] text-[#46A302] border-2 border-[#58CC02]'
                          : 'bg-[#F7F7F7] text-[#777777] border border-[#E5E5E5] hover:bg-white'
                      }`}
                    >
                      {s.pageIndex}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Return to supervisor page notice OR active writers count */}
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
                {canDraw ? (
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
            backgroundImage={activeSlide?.imageData}
            overlayStrokeLayers={otherLayers}
            viewOnly={!canDraw}
            syncIntervalMs={240}
            heightClass={
              isFullscreen
                ? 'h-[calc(100dvh-235px)] sm:h-[calc(100dvh-205px)] min-h-[240px]'
                : 'h-[48dvh] min-h-[240px] sm:h-[64dvh] md:h-[72dvh]'
            }
          />

          {/* Active Contributors on this page */}
          {activeContributors.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-1 text-xs font-bold text-[#777777]">
              <span>المشاركون بالكتابة في هذه الصفحة:</span>
              {activeContributors.map((layer) => (
                <span
                  key={layer.id}
                  className="px-2.5 py-0.5 rounded-lg bg-[#F7F7F7] border border-[#E5E5E5] text-[#3C3C3C] font-extrabold"
                >
                  {layer.authorName}
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
