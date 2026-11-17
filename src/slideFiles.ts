import {
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db } from './firebase';
import { compressSlideImageToDataUrl, renderPdfToSlideImages } from './pdfUtils';
import { BOARD_HEIGHT, BOARD_WIDTH, renderStrokesToCanvas } from './components/WhiteboardCanvas';
import {
  loadSessionSnapshot,
  saveSavedTestsListSnapshot,
  type StoredSavedTestsSnapshot,
} from './localDraftStore';
import type {
  ExplainLayer,
  InteractiveSlide,
  Participant,
  ParticipantSummary,
  Room,
  SavedBoardSnapshot,
  SavedQuestion,
  SavedTest,
  SlideLayer,
  Stroke,
} from './types';

export const MAX_ROOM_SLIDES = 100;
export const MAX_PAGES_PER_PDF = 100;

export interface SlideFileGroup {
  fileId: string;
  fileName: string;
  slides: InteractiveSlide[];
  startPageIndex: number;
  endPageIndex: number;
}

export interface ParsedSlideFileBatch {
  fileId: string;
  fileName: string;
  images: string[];
}

export function createSafeFileId(indexOffset = 0): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `f_${stamp}_${indexOffset}_${rand}`.replace(/[^a-zA-Z0-9_-]/g, '');
}

export function sanitizeSlideFileName(rawName: string | undefined, fallback = 'ملف مرفوع'): string {
  const cleaned = (rawName || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return fallback;
  return cleaned.slice(0, 155);
}

/**
 * تجميع شرائح الغرفة في مجموعات ملفات مرتبة حسب الظهور والترتيب.
 * يدعم الشرائح القديمة التي لا تحتوي على fileId بوضعها في مجموعة واحدة متوافقة.
 */
export function groupSlidesIntoFiles(slides: InteractiveSlide[]): SlideFileGroup[] {
  if (slides.length === 0) return [];
  const sorted = [...slides].sort((a, b) => a.pageIndex - b.pageIndex);
  const groups: SlideFileGroup[] = [];
  const groupById = new Map<string, SlideFileGroup>();

  for (const slide of sorted) {
    const fid = slide.fileId || 'legacy_session_file';
    const existing = groupById.get(fid);
    if (existing) {
      existing.slides.push(slide);
      existing.endPageIndex = slide.pageIndex;
    } else {
      const nextGroup: SlideFileGroup = {
        fileId: fid,
        fileName: sanitizeSlideFileName(slide.fileName, 'ملف الجلسة'),
        slides: [slide],
        startPageIndex: slide.pageIndex,
        endPageIndex: slide.pageIndex,
      };
      groups.push(nextGroup);
      groupById.set(fid, nextGroup);
    }
  }

  return groups;
}

/**
 * قراءة ومعالجة ملف واحد أو أكثر (PDF أو صور) وإرجاع صفحات كل ملف مع اسمه ومعرفه.
 */
export async function parseUploadedFilesToBatches(
  rawFiles: File[],
  maxRemainingSlides: number,
  onProgress?: (status: string) => void
): Promise<{
  batches: ParsedSlideFileBatch[];
  totalPages: number;
  warnings: string[];
}> {
  const batches: ParsedSlideFileBatch[] = [];
  const warnings: string[] = [];
  let remaining = Math.max(0, maxRemainingSlides);
  let totalPages = 0;

  for (let i = 0; i < rawFiles.length; i++) {
    if (remaining <= 0) {
      warnings.push(`تم الوصول للحد الأقصى (${MAX_ROOM_SLIDES} صفحة) وتجاهل بقية الملفات.`);
      break;
    }

    const file = rawFiles[i];
    const cleanName = sanitizeSlideFileName(file.name, `ملف_${i + 1}`);
    const isPdf =
      file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const isImage = file.type.startsWith('image/');

    if (!isPdf && !isImage) {
      warnings.push(`تم تخطي «${cleanName}»: يدعم فقط PDF أو الصور (PNG/JPG).`);
      continue;
    }

    let images: string[] = [];
    if (isPdf) {
      onProgress?.(
        `ملف (${i + 1}/${rawFiles.length}): جاري قراءة «${cleanName}»...`
      );
      const pdfLimit = Math.min(MAX_PAGES_PER_PDF, remaining);
      images = await renderPdfToSlideImages(
        file,
        (done, total) => {
          onProgress?.(
            `ملف (${i + 1}/${rawFiles.length}): «${cleanName}» — صفحة ${done} من ${total}...`
          );
        },
        pdfLimit
      );
    } else {
      onProgress?.(
        `ملف (${i + 1}/${rawFiles.length}): جاري تجهيز الصورة «${cleanName}»...`
      );
      const dataUrl = await compressSlideImageToDataUrl(file);
      images = [dataUrl];
    }

    if (images.length === 0) {
      warnings.push(`لم يتم العثور على صفحات قابلة للعرض في «${cleanName}».`);
      continue;
    }

    const sliced = images.slice(0, remaining);
    remaining -= sliced.length;
    totalPages += sliced.length;

    batches.push({
      fileId: createSafeFileId(i),
      fileName: cleanName,
      images: sliced,
    });
  }

  return { batches, totalPages, warnings };
}

/**
 * رفع دفعات الملفات الجديدة إلى الغرفة (مع خيار استبدال الكل أو الإضافة على الملفات الحالية).
 */
export async function uploadSlideBatchesToRoom(params: {
  roomId: string;
  existingSlides: InteractiveSlide[];
  batches: ParsedSlideFileBatch[];
  replaceAll: boolean;
  onProgress?: (status: string) => void;
}): Promise<{ firstNewPageIndex: number; totalSlideCount: number }> {
  const { roomId, existingSlides, batches, replaceAll, onProgress } = params;

  if (replaceAll && existingSlides.length > 0) {
    onProgress?.('جاري إزالة الملفات السابقة...');
    await deleteSlidesAndLayers(roomId, existingSlides);
  }

  const basePageIndex = replaceAll
    ? 1
    : Math.max(...existingSlides.map((s) => s.pageIndex), 0) + 1;

  const flatToWrite: Array<{
    slideId: string;
    pageIndex: number;
    imageData: string;
    fileId: string;
    fileName: string;
    filePageIndex: number;
  }> = [];

  const batchStamp = Date.now().toString(36);
  let cursor = basePageIndex;

  batches.forEach((b, bIdx) => {
    b.images.forEach((imgData, pIdx) => {
      const pageIndex = cursor++;
      const slideId = `s_${batchStamp}_${bIdx}_${pageIndex}`;
      flatToWrite.push({
        slideId,
        pageIndex,
        imageData: imgData,
        fileId: b.fileId,
        fileName: b.fileName,
        filePageIndex: pIdx + 1,
      });
    });
  });

  const CHUNK_SIZE = 5;
  for (let i = 0; i < flatToWrite.length; i += CHUNK_SIZE) {
    const chunk = flatToWrite.slice(i, i + CHUNK_SIZE);
    onProgress?.(
      `جاري رفع الصفحات (${Math.min(i + chunk.length, flatToWrite.length)} / ${flatToWrite.length})...`
    );
    const batch = writeBatch(db);
    chunk.forEach((item) => {
      batch.set(doc(db, 'rooms', roomId, 'slides', item.slideId), {
        id: item.slideId,
        roomId,
        pageIndex: item.pageIndex,
        imageData: item.imageData,
        fileId: item.fileId,
        fileName: item.fileName,
        filePageIndex: item.filePageIndex,
        createdAt: serverTimestamp(),
      });
    });
    await batch.commit();
  }

  const firstNewPageIndex = flatToWrite[0]?.pageIndex ?? 1;
  const totalSlideCount = replaceAll
    ? flatToWrite.length
    : existingSlides.length + flatToWrite.length;

  await updateDoc(doc(db, 'rooms', roomId), {
    currentSlideIndex: firstNewPageIndex,
    slideCount: totalSlideCount,
    updatedAt: serverTimestamp(),
  });

  return { firstNewPageIndex, totalSlideCount };
}

/**
 * حذف شرائح محددة مع طبقات الرسم عليها من Firestore.
 */
async function deleteSlidesAndLayers(
  roomId: string,
  slidesToDelete: InteractiveSlide[]
): Promise<void> {
  for (const slide of slidesToDelete) {
    const layersSnap = await getDocs(
      query(
        collection(db, 'rooms', roomId, 'slides', slide.id, 'layers'),
        where('roomId', '==', roomId),
        where('slideId', '==', slide.id)
      )
    );
    const delBatch = writeBatch(db);
    layersSnap.forEach((d) => delBatch.delete(d.ref));
    delBatch.delete(doc(db, 'rooms', roomId, 'slides', slide.id));
    await delBatch.commit();
  }
}

/**
 * حذف ملف كامل (أو شريحة واحدة) وإعادة ترقيم الصفحات المتبقية 1..N وتحديث مؤشر الغرفة.
 */
export async function removeSlidesAndReindex(params: {
  roomId: string;
  allSlides: InteractiveSlide[];
  slidesToRemove: InteractiveSlide[];
  currentSlideIndex: number;
}): Promise<{ nextCurrentSlideIndex: number; nextCount: number }> {
  const { roomId, allSlides, slidesToRemove, currentSlideIndex } = params;
  if (slidesToRemove.length === 0) {
    return { nextCurrentSlideIndex: currentSlideIndex, nextCount: allSlides.length };
  }

  const removeIds = new Set(slidesToRemove.map((s) => s.id));
  const sortedAll = [...allSlides].sort((a, b) => a.pageIndex - b.pageIndex);
  const currentActiveSlide =
    sortedAll.find((s) => s.pageIndex === currentSlideIndex) ?? null;

  await deleteSlidesAndLayers(roomId, slidesToRemove);

  const remaining = sortedAll.filter((s) => !removeIds.has(s.id));

  // Re-index remaining slides cleanly 1..remaining.length
  const updatesNeeded: Array<{ id: string; newPageIndex: number }> = [];
  let nextCurrentSlideIndex = 0;

  remaining.forEach((slide, idx) => {
    const newPageIndex = idx + 1;
    if (slide.pageIndex !== newPageIndex) {
      updatesNeeded.push({ id: slide.id, newPageIndex });
    }
    if (currentActiveSlide && slide.id === currentActiveSlide.id) {
      nextCurrentSlideIndex = newPageIndex;
    }
  });

  if (remaining.length > 0 && nextCurrentSlideIndex === 0) {
    if (currentSlideIndex <= 0) {
      nextCurrentSlideIndex = 0;
    } else {
      nextCurrentSlideIndex = Math.min(remaining.length, Math.max(1, currentSlideIndex));
    }
  }

  const REINDEX_CHUNK = 40;
  for (let i = 0; i < updatesNeeded.length; i += REINDEX_CHUNK) {
    const batch = writeBatch(db);
    updatesNeeded.slice(i, i + REINDEX_CHUNK).forEach((item) => {
      batch.update(doc(db, 'rooms', roomId, 'slides', item.id), {
        pageIndex: item.newPageIndex,
      });
    });
    await batch.commit();
  }

  await updateDoc(doc(db, 'rooms', roomId), {
    currentSlideIndex: nextCurrentSlideIndex,
    slideCount: remaining.length,
    updatedAt: serverTimestamp(),
  });

  return { nextCurrentSlideIndex, nextCount: remaining.length };
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load error'));
    img.src = src;
  });
}

/**
 * دمج خلفية الشريحة (إن وجدت) مع جميع طبقات الرسم في صورة PNG عالية الدقة.
 */
export async function renderAnnotatedSlideToDataUrl(
  imageData: string | undefined,
  strokeLayers: Stroke[][]
): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = BOARD_WIDTH;
  canvas.height = BOARD_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);

  if (imageData) {
    try {
      const img = await loadHtmlImage(imageData);
      const iw = img.naturalWidth || img.width || BOARD_WIDTH;
      const ih = img.naturalHeight || img.height || BOARD_HEIGHT;
      const scale = Math.min(BOARD_WIDTH / iw, BOARD_HEIGHT / ih);
      const drawW = iw * scale;
      const drawH = ih * scale;
      const dx = (BOARD_WIDTH - drawW) / 2;
      const dy = (BOARD_HEIGHT - drawH) / 2;
      ctx.drawImage(img, dx, dy, drawW, drawH);
    } catch {
      // Continue rendering annotations cleanly if background image fails to decode
    }
  }

  const nonEmptyLayers = strokeLayers.filter((layer) => layer && layer.length > 0);
  if (nonEmptyLayers.length > 0) {
    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = BOARD_WIDTH;
    layerCanvas.height = BOARD_HEIGHT;
    const layerCtx = layerCanvas.getContext('2d');
    if (layerCtx) {
      for (const layerStrokes of nonEmptyLayers) {
        renderStrokesToCanvas(layerCtx, layerStrokes, BOARD_WIDTH, BOARD_HEIGHT, true);
        ctx.drawImage(layerCanvas, 0, 0);
      }
    }
  }

  return canvas.toDataURL('image/png');
}

export function triggerDataUrlDownload(dataUrl: string, filename: string): void {
  if (!dataUrl) return;
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * جلب كل طبقات الرسم لصفحة محددة (مفيدة لتنزيل كل صفحات الجلسة دفعة واحدة).
 */
export async function fetchSlideStrokeLayers(
  roomId: string,
  slideId: string
): Promise<Stroke[][]> {
  const snap = await getDocs(
    query(
      collection(db, 'rooms', roomId, 'slides', slideId, 'layers'),
      where('roomId', '==', roomId),
      where('slideId', '==', slideId)
    )
  );
  const result: Stroke[][] = [];
  snap.forEach((d) => {
    const layer = d.data() as SlideLayer;
    if (layer.strokes && layer.strokes.length > 0) {
      result.push(layer.strokes);
    }
  });
  return result;
}

/**
 * حفظ ملفات الجلسة والسبورات الحالية كنسخة محفوظة في سجل المستخدم (اختباراتي المحفوظة + IndexedDB).
 */
export async function saveSessionFilesToArchive(params: {
  uid: string;
  room: Room;
  participants: Participant[];
  userRole: 'supervisor' | 'student';
  slides: InteractiveSlide[];
  blankExplainLayers?: ExplainLayer[];
  legacySharedStrokes?: Stroke[];
  customTitle?: string;
}): Promise<{ savedTestId: string; savedCount: number }> {
  const {
    uid,
    room,
    participants,
    userRole,
    slides,
    blankExplainLayers = [],
    legacySharedStrokes = [],
    customTitle,
  } = params;

  const sortedSlides = [...slides].sort((a, b) => a.pageIndex - b.pageIndex);
  const assembledQuestions: SavedQuestion[] = [];

  for (const slide of sortedSlides) {
    const layersSnap = await getDocs(
      query(
        collection(db, 'rooms', room.id, 'slides', slide.id, 'layers'),
        where('roomId', '==', room.id),
        where('slideId', '==', slide.id)
      )
    );
    const boardsList: SavedBoardSnapshot[] = [];
    layersSnap.forEach((d) => {
      const layer = d.data() as SlideLayer;
      if ((layer.strokes?.length ?? 0) > 0) {
        boardsList.push({
          studentId: layer.authorId,
          studentName: layer.authorName,
          strokes: layer.strokes ?? [],
          submitted: true,
          verdict: 'pending',
        });
      }
    });

    const pageTitle = slide.fileName
      ? `${slide.fileName} — صفحة ${slide.filePageIndex ?? slide.pageIndex}`
      : `صفحة ${slide.pageIndex}`;

    assembledQuestions.push({
      id: slide.id,
      ownerId: uid,
      orderIndex: slide.pageIndex,
      text: pageTitle.slice(0, 2000),
      imageData: slide.imageData,
      status: 'solving',
      winnerName: '',
      boards: boardsList,
      createdAt: slide.createdAt,
    });
  }

  // Optional blank whiteboard layers from Explain Mode
  const blankBoards: SavedBoardSnapshot[] = [];
  for (const layer of blankExplainLayers) {
    if ((layer.strokes?.length ?? 0) > 0) {
      blankBoards.push({
        studentId: layer.authorId,
        studentName: layer.authorName,
        strokes: layer.strokes ?? [],
        submitted: true,
        verdict: 'pending',
      });
    }
  }
  if (legacySharedStrokes.length > 0 && blankBoards.length === 0) {
    blankBoards.push({
      studentId: room.supervisorId,
      studentName: room.supervisorName,
      strokes: legacySharedStrokes,
      submitted: true,
      verdict: 'pending',
    });
  }
  if (blankBoards.length > 0) {
    assembledQuestions.push({
      id: `blank_board_${Date.now().toString(36)}`,
      ownerId: uid,
      orderIndex: assembledQuestions.length + 1,
      text: 'السبورة البيضاء المشتركة للشرح',
      imageData: '',
      status: 'solving',
      winnerName: '',
      boards: blankBoards,
    });
  }

  if (assembledQuestions.length === 0) {
    throw new Error('لا توجد ملفات أو رسومات في الجلسة لحفظها بعد');
  }

  const savedTestId = `${room.id}_files_${Date.now().toString(36)}`.replace(/[^a-zA-Z0-9_-]/g, '');
  const titleBase =
    customTitle?.trim() ||
    (room.title ? `${room.title} (ملفات الجلسة)` : `ملفات جلسة ${room.id}`);
  const safeTitle = titleBase.slice(0, 120);
  const safeSupervisorName =
    room.supervisorName && room.supervisorName.trim().length >= 5
      ? room.supervisorName.trim().slice(0, 120)
      : 'مشرف الجلسة التفاعلية';

  const pSummary: ParticipantSummary[] = [...participants]
    .sort((a, b) => b.score - a.score || b.correctCount - a.correctCount)
    .slice(0, 100)
    .map((p) => ({
      uid: p.uid,
      fullNameQuad: p.fullNameQuad,
      score: p.score,
      correctCount: p.correctCount,
    }));

  const savedTestRef = doc(db, 'users', uid, 'savedTests', savedTestId);
  const CHUNK = 5;
  const firstChunk = assembledQuestions.slice(0, CHUNK);
  const firstBatch = writeBatch(db);

  firstBatch.set(savedTestRef, {
    id: savedTestId,
    ownerId: uid,
    roomCode: room.id,
    title: safeTitle,
    userRole,
    supervisorName: safeSupervisorName,
    totalQuestions: assembledQuestions.length,
    participantsSummary: pSummary,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  for (const sq of firstChunk) {
    const sqRef = doc(db, 'users', uid, 'savedTests', savedTestId, 'questions', sq.id);
    firstBatch.set(sqRef, {
      id: sq.id,
      ownerId: uid,
      orderIndex: sq.orderIndex,
      text: sq.text,
      imageData: sq.imageData,
      status: sq.status,
      winnerName: sq.winnerName,
      boards: sq.boards,
      createdAt: serverTimestamp(),
    });
  }
  await firstBatch.commit();

  for (let i = CHUNK; i < assembledQuestions.length; i += CHUNK) {
    const batch = writeBatch(db);
    for (const sq of assembledQuestions.slice(i, i + CHUNK)) {
      const sqRef = doc(db, 'users', uid, 'savedTests', savedTestId, 'questions', sq.id);
      batch.set(sqRef, {
        id: sq.id,
        ownerId: uid,
        orderIndex: sq.orderIndex,
        text: sq.text,
        imageData: sq.imageData,
        status: sq.status,
        winnerName: sq.winnerName,
        boards: sq.boards,
        createdAt: serverTimestamp(),
      });
    }
    await batch.commit();
  }

  // Mirror to IndexedDB
  const localSavedObj: SavedTest = {
    id: savedTestId,
    ownerId: uid,
    roomCode: room.id,
    title: safeTitle,
    userRole,
    supervisorName: safeSupervisorName,
    totalQuestions: assembledQuestions.length,
    participantsSummary: pSummary,
  };
  const existingSnap = await loadSessionSnapshot<StoredSavedTestsSnapshot>('saved_tests');
  const prevTests =
    existingSnap && existingSnap.ownerId === uid
      ? existingSnap.tests.filter((t) => t.id !== savedTestId)
      : [];
  void saveSavedTestsListSnapshot(uid, [localSavedObj, ...prevTests], {
    [savedTestId]: assembledQuestions,
  });

  return { savedTestId, savedCount: assembledQuestions.length };
}
