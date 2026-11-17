import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Eraser,
  Hand,
  Maximize2,
  Palette,
  PenTool,
  RotateCcw,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { Stroke } from '../types';
import { DuoLockShield } from './DuoIcons';

export const BOARD_WIDTH = 1200;
export const BOARD_HEIGHT = 700;

export const PEN_COLORS = [
  { id: 'black', label: 'أسود', hex: '#1F2937' },
  { id: 'blue', label: 'أزرق', hex: '#1CB0F6' },
  { id: 'red', label: 'أحمر', hex: '#EA2B2B' },
  { id: 'green', label: 'أخضر', hex: '#58CC02' },
  { id: 'gold', label: 'ذهبي', hex: '#FFC800' },
  { id: 'orange', label: 'برتقالي', hex: '#FF9600' },
  { id: 'purple', label: 'بنفسجي', hex: '#CE82FF' },
  { id: 'pink', label: 'وردي', hex: '#FF6B9D' },
  { id: 'teal', label: 'تركواز', hex: '#0D9488' },
  { id: 'gray', label: 'رمادي', hex: '#6B7280' },
] as const;

const PEN_SIZES = [
  { label: 'دقيق', size: 2 },
  { label: 'رفيع', size: 4 },
  { label: 'متوسط', size: 8 },
  { label: 'سميك', size: 14 },
  { label: 'عريض', size: 22 },
];

function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  transparentBg: boolean
) {
  const pts = stroke.pts;
  if (!pts || pts.length < 2) return;

  ctx.beginPath();
  if (stroke.isEraser && transparentBg) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = stroke.isEraser ? '#FFFFFF' : stroke.color;
  }
  ctx.lineWidth = stroke.isEraser ? Math.max(stroke.width * 2.4, 24) : stroke.width;

  ctx.moveTo(pts[0], pts[1]);
  if (pts.length === 2) {
    ctx.lineTo(pts[0] + 0.1, pts[1] + 0.1);
  } else {
    for (let i = 2; i < pts.length; i += 2) {
      const prevX = pts[i - 2];
      const prevY = pts[i - 1];
      const currX = pts[i];
      const currY = pts[i + 1];
      const midX = (prevX + currX) / 2;
      const midY = (prevY + currY) / 2;
      ctx.quadraticCurveTo(prevX, prevY, midX, midY);
    }
    ctx.lineTo(pts[pts.length - 2], pts[pts.length - 1]);
  }
  ctx.stroke();
}

export function renderStrokesToCanvas(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  width: number,
  height: number,
  transparentBg = false
) {
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  if (!transparentBg) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
  }

  const scaleX = width / BOARD_WIDTH;
  const scaleY = height / BOARD_HEIGHT;
  ctx.scale(scaleX, scaleY);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const stroke of strokes) {
    drawStroke(ctx, stroke, transparentBg);
  }
  ctx.restore();
}

export function renderStrokesToDataUrl(strokes: Stroke[]): string {
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 560;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  renderStrokesToCanvas(ctx, strokes, canvas.width, canvas.height);
  const pngUrl = canvas.toDataURL('image/png');
  if (pngUrl.length <= 240000) return pngUrl;
  return canvas.toDataURL('image/jpeg', 0.78);
}

function distToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  const rx = px - projX;
  const ry = py - projY;
  return rx * rx + ry * ry;
}

export function doesStrokeIntersectEraser(
  eraserPts: number[],
  targetPts: number[],
  hitRadius: number
): boolean {
  if (eraserPts.length < 2 || targetPts.length < 2) return false;
  const rSq = hitRadius * hitRadius;

  // Quick bounding-box reject
  let eMinX = Infinity, eMaxX = -Infinity, eMinY = Infinity, eMaxY = -Infinity;
  for (let i = 0; i < eraserPts.length; i += 2) {
    const x = eraserPts[i];
    const y = eraserPts[i + 1];
    if (x < eMinX) eMinX = x;
    if (x > eMaxX) eMaxX = x;
    if (y < eMinY) eMinY = y;
    if (y > eMaxY) eMaxY = y;
  }
  let tMinX = Infinity, tMaxX = -Infinity, tMinY = Infinity, tMaxY = -Infinity;
  for (let i = 0; i < targetPts.length; i += 2) {
    const x = targetPts[i];
    const y = targetPts[i + 1];
    if (x < tMinX) tMinX = x;
    if (x > tMaxX) tMaxX = x;
    if (y < tMinY) tMinY = y;
    if (y > tMaxY) tMaxY = y;
  }
  if (
    eMaxX + hitRadius < tMinX ||
    eMinX - hitRadius > tMaxX ||
    eMaxY + hitRadius < tMinY ||
    eMinY - hitRadius > tMaxY
  ) {
    return false;
  }

  for (let i = 0; i < eraserPts.length; i += 2) {
    const ex = eraserPts[i];
    const ey = eraserPts[i + 1];
    if (targetPts.length === 2) {
      const dx = ex - targetPts[0];
      const dy = ey - targetPts[1];
      if (dx * dx + dy * dy <= rSq) return true;
    } else {
      for (let j = 2; j < targetPts.length; j += 2) {
        if (
          distToSegmentSq(
            ex,
            ey,
            targetPts[j - 2],
            targetPts[j - 1],
            targetPts[j],
            targetPts[j + 1]
          ) <= rSq
        ) {
          return true;
        }
      }
    }
  }

  for (let j = 0; j < targetPts.length; j += 2) {
    const tx = targetPts[j];
    const ty = targetPts[j + 1];
    if (eraserPts.length >= 4) {
      for (let i = 2; i < eraserPts.length; i += 2) {
        if (
          distToSegmentSq(
            tx,
            ty,
            eraserPts[i - 2],
            eraserPts[i - 1],
            eraserPts[i],
            eraserPts[i + 1]
          ) <= rSq
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export const WhiteboardPreview: React.FC<{
  strokes: Stroke[];
  backgroundImage?: string;
  className?: string;
  emptyText?: string;
}> = ({
  strokes,
  backgroundImage,
  className = 'w-full aspect-[12/7]',
  emptyText = 'لم يكتب بعد',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    renderStrokesToCanvas(ctx, strokes, canvas.width, canvas.height, Boolean(backgroundImage));
  }, [strokes, backgroundImage]);

  return (
    <div className={`relative rounded-xl overflow-hidden bg-white border-2 border-[#E5E5E5] ${className}`}>
      {backgroundImage && (
        <img
          src={backgroundImage}
          alt="خلفية الصفحة"
          className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
        />
      )}
      <canvas
        ref={canvasRef}
        width={600}
        height={350}
        className="relative z-[1] w-full h-full block object-contain bg-transparent"
      />
      {strokes.length === 0 && !backgroundImage && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-xs font-bold text-[#AFAFAF]">{emptyText}</span>
        </div>
      )}
    </div>
  );
};

interface WhiteboardCanvasProps {
  strokes: Stroke[];
  onStrokesChange: (next: Stroke[]) => void;
  onEraserSweep?: (eraserStroke: Stroke) => void;
  backgroundImage?: string;
  overlayStrokeLayers?: Stroke[][];
  disabled?: boolean;
  viewOnly?: boolean;
  viewOnlyLabel?: string;
  syncIntervalMs?: number;
  lockTitle?: string;
  lockSubtitle?: string;
  heightClass?: string;
}

export const WhiteboardCanvas: React.FC<WhiteboardCanvasProps> = ({
  strokes,
  onStrokesChange,
  onEraserSweep,
  backgroundImage,
  overlayStrokeLayers = [],
  disabled = false,
  viewOnly = false,
  viewOnlyLabel,
  syncIntervalMs = 550,
  lockTitle = 'السبورة مقفلة حالياً',
  lockSubtitle = 'بانتظار المشرف لإدراج السؤال',
  heightClass = 'h-[250px] sm:h-[380px] md:h-[490px] lg:h-[540px]',
}) => {
  const committedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const tempOverlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const [tool, setTool] = useState<'pen' | 'eraser' | 'pan'>('pen');
  const [color, setColor] = useState<string>(PEN_COLORS[0].hex);
  const [penSize, setPenSize] = useState<number>(6);
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const zoomRef = useRef<number>(1);
  const panRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartRef = useRef<{
    dist: number;
    zoom: number;
    midX: number;
    midY: number;
    origPanX: number;
    origPanY: number;
  } | null>(null);

  const isDrawingRef = useRef(false);
  const isPanningRef = useRef(false);
  const panStartRef = useRef<{ x: number; y: number; origX: number; origY: number }>({
    x: 0,
    y: 0,
    origX: 0,
    origY: 0,
  });
  const activeStrokeRef = useRef<Stroke | null>(null);
  const erasedPtCursorRef = useRef<number>(0);
  const localStrokesRef = useRef<Stroke[]>(strokes);
  const lastSyncRef = useRef<number>(0);
  const rafIdRef = useRef<number | null>(null);

  const redrawCommitted = useCallback(() => {
    const committed = committedCanvasRef.current;
    if (!committed) return;
    const ctx = committed.getContext('2d');
    if (!ctx) return;
    renderStrokesToCanvas(ctx, localStrokesRef.current, BOARD_WIDTH, BOARD_HEIGHT, true);
  }, []);

  const redrawActive = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
    const active = activeStrokeRef.current;
    if (!active) return;

    if (active.isEraser) {
      // Carve newly added eraser points incrementally onto committedCanvasRef in O(delta)
      const committed = committedCanvasRef.current;
      const cCtx = committed?.getContext('2d');
      const pts = active.pts;
      if (cCtx && pts.length >= 2) {
        const startIdx = Math.max(0, erasedPtCursorRef.current - 2);
        const deltaPts = pts.slice(startIdx);
        if (deltaPts.length >= 2) {
          cCtx.save();
          cCtx.lineCap = 'round';
          cCtx.lineJoin = 'round';
          drawStroke(cCtx, { ...active, pts: deltaPts }, true);
          cCtx.restore();
        }
        erasedPtCursorRef.current = pts.length;
      }
      // Show subtle eraser ring indicator on active canvas
      const lx = pts[pts.length - 2];
      const ly = pts[pts.length - 1];
      if (lx !== undefined && ly !== undefined) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(lx, ly, Math.max(active.width * 1.2, 12), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(24, 153, 214, 0.55)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }
      return;
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    drawStroke(ctx, active, true);
    ctx.restore();
  }, []);

  const scheduleActiveRedraw = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      redrawActive();
    });
  }, [redrawActive]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isDrawingRef.current) {
      localStrokesRef.current = strokes;
      redrawCommitted();
    }
  }, [strokes, redrawCommitted]);

  useEffect(() => {
    const overlayCanvas = overlayCanvasRef.current;
    if (!overlayCanvas) return;
    const ctx = overlayCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
    if (overlayStrokeLayers.length === 0) return;

    if (!tempOverlayCanvasRef.current) {
      const tc = document.createElement('canvas');
      tc.width = BOARD_WIDTH;
      tc.height = BOARD_HEIGHT;
      tempOverlayCanvasRef.current = tc;
    }
    const tempCanvas = tempOverlayCanvasRef.current;
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) return;

    for (const layerStrokes of overlayStrokeLayers) {
      if (!layerStrokes || layerStrokes.length === 0) continue;
      renderStrokesToCanvas(tempCtx, layerStrokes, BOARD_WIDTH, BOARD_HEIGHT, true);
      ctx.drawImage(tempCanvas, 0, 0);
    }
  }, [overlayStrokeLayers]);

  const getBoardPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = Math.round(((clientX - rect.left) / rect.width) * BOARD_WIDTH);
    const y = Math.round(((clientY - rect.top) / rect.height) * BOARD_HEIGHT);
    return {
      x: Math.max(0, Math.min(BOARD_WIDTH, x)),
      y: Math.max(0, Math.min(BOARD_HEIGHT, y)),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // 2-finger pinch-to-zoom & pan on touchscreens
    if (pointersRef.current.size === 2) {
      isDrawingRef.current = false;
      activeStrokeRef.current = null;
      erasedPtCursorRef.current = 0;
      isPanningRef.current = false;
      redrawCommitted();
      redrawActive();

      const pts = Array.from(pointersRef.current.values()) as Array<{ x: number; y: number }>;
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      pinchStartRef.current = {
        dist: Math.max(dist, 10),
        zoom: zoomRef.current,
        midX,
        midY,
        origPanX: panRef.current.x,
        origPanY: panRef.current.y,
      };
      return;
    }

    if (disabled || viewOnly) {
      if (tool === 'pan' || viewOnly || e.button === 1) {
        isPanningRef.current = true;
        panStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          origX: pan.x,
          origY: pan.y,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      return;
    }

    if (tool === 'pan' || e.button === 1) {
      isPanningRef.current = true;
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        origX: pan.x,
        origY: pan.y,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    const pt = getBoardPoint(e.clientX, e.clientY);
    if (!pt) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    isDrawingRef.current = true;
    erasedPtCursorRef.current = 0;
    lastSyncRef.current = Date.now();
    activeStrokeRef.current = {
      color,
      width: penSize,
      isEraser: tool === 'eraser',
      pts: [pt.x, pt.y],
    };
    redrawActive();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (pointersRef.current.size === 2 && pinchStartRef.current) {
      const pts = Array.from(pointersRef.current.values()) as Array<{ x: number; y: number }>;
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const start = pinchStartRef.current;
      const nextZoom = Math.max(
        0.5,
        Math.min(4.0, Number((start.zoom * (dist / start.dist)).toFixed(2)))
      );
      setZoom(nextZoom);
      setPan({
        x: start.origPanX + (midX - start.midX),
        y: start.origPanY + (midY - start.midY),
      });
      return;
    }

    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      setPan({
        x: panStartRef.current.origX + dx,
        y: panStartRef.current.origY + dy,
      });
      return;
    }

    if (!isDrawingRef.current || !activeStrokeRef.current || disabled || viewOnly) return;

    const nativeEvt = e.nativeEvent as PointerEvent;
    const coalesced =
      typeof nativeEvt.getCoalescedEvents === 'function'
        ? nativeEvt.getCoalescedEvents()
        : null;
    const eventsToProcess = coalesced && coalesced.length > 0 ? coalesced : [nativeEvt];

    const pts = activeStrokeRef.current.pts;
    let appended = false;

    for (const ce of eventsToProcess) {
      if (pts.length >= 700) break;
      const pt = getBoardPoint(ce.clientX, ce.clientY);
      if (!pt) continue;
      const lastX = pts[pts.length - 2];
      const lastY = pts[pts.length - 1];
      const dist = Math.hypot(pt.x - lastX, pt.y - lastY);
      if (dist >= 1.8) {
        pts.push(pt.x, pt.y);
        appended = true;
      }
    }

    if (appended) {
      scheduleActiveRedraw();
    }

    const now = Date.now();
    if (now - lastSyncRef.current >= syncIntervalMs && pts.length >= 2) {
      lastSyncRef.current = now;
      const strokeCopy = { ...activeStrokeRef.current, pts: [...pts] };
      if (strokeCopy.isEraser && onEraserSweep) {
        onEraserSweep(strokeCopy);
      }
      const snapshot = [...localStrokesRef.current, strokeCopy];
      onStrokesChange(snapshot.slice(-380));
    }
  };

  const finishStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) {
      pinchStartRef.current = null;
    }

    if (isPanningRef.current) {
      isPanningRef.current = false;
      return;
    }
    if (!isDrawingRef.current || !activeStrokeRef.current) return;
    isDrawingRef.current = false;
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const finished = activeStrokeRef.current;
    activeStrokeRef.current = null;
    erasedPtCursorRef.current = 0;
    if (finished.isEraser && onEraserSweep) {
      onEraserSweep(finished);
    }
    const next = [...localStrokesRef.current, finished].slice(-380);
    localStrokesRef.current = next;
    redrawCommitted();
    redrawActive();
    onStrokesChange(next);
  };

  const handleWheelZoom = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey && tool !== 'pan' && !viewOnly) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.15 : -0.15;
    setZoom((z) => Math.max(0.5, Math.min(4.0, Number((z + delta).toFixed(2)))));
  };

  const handleUndo = () => {
    if (disabled || localStrokesRef.current.length === 0) return;
    const next = localStrokesRef.current.slice(0, -1);
    localStrokesRef.current = next;
    redrawCommitted();
    redrawActive();
    onStrokesChange(next);
  };

  const handleClear = () => {
    if (disabled || localStrokesRef.current.length === 0) return;
    localStrokesRef.current = [];
    redrawCommitted();
    redrawActive();
    onStrokesChange([]);
  };

  const handleZoomIn = () => setZoom((z) => Math.min(4.0, Number((z + 0.25).toFixed(2))));
  const handleZoomOut = () => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))));
  const handleResetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div className="flex flex-col gap-2.5 sm:gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-[#F7F7F7] border-2 border-[#E5E5E5] rounded-2xl p-2 sm:p-2.5">
        {viewOnly ? (
          <div className="flex items-center gap-2 px-2 py-1 text-[11px] sm:text-xs font-black text-[#1899D6]">
            <span>{viewOnlyLabel || 'وضع المشاهدة المباشرة — يمكنك التكبير أو التحريك لمتابعة الشرح'}</span>
          </div>
        ) : (
        /* Colors, Thickness Slider & Drawing Tools */
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {/* Expanded Colors Palette + Custom Color Picker */}
          <div className="flex flex-wrap items-center gap-1 bg-white border-2 border-[#E5E5E5] rounded-xl px-1.5 sm:px-2 py-1">
            {PEN_COLORS.map((c) => {
              const active = tool === 'pen' && color.toLowerCase() === c.hex.toLowerCase();
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setColor(c.hex);
                    setTool('pen');
                  }}
                  title={c.label}
                  aria-label={c.label}
                  className={`w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center transition-transform shrink-0 cursor-pointer disabled:opacity-50 ${
                    active
                      ? 'ring-2 ring-offset-1 ring-[#1CB0F6] scale-110'
                      : 'hover:scale-105'
                  }`}
                >
                  <span
                    className="w-4 h-4 sm:w-5 sm:h-5 rounded-full border border-black/15 shadow-xs block"
                    style={{ backgroundColor: c.hex }}
                  />
                </button>
              );
            })}

            {/* Custom Any-Color Picker */}
            <label
              title="لون مخصص"
              className={`relative w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center cursor-pointer transition-transform shrink-0 border border-[#E5E5E5] bg-[#F7F7F7] hover:scale-105 ${
                tool === 'pen' &&
                !PEN_COLORS.some((c) => c.hex.toLowerCase() === color.toLowerCase())
                  ? 'ring-2 ring-offset-1 ring-[#1CB0F6] scale-110'
                  : ''
              }`}
              style={{
                backgroundColor: !PEN_COLORS.some(
                  (c) => c.hex.toLowerCase() === color.toLowerCase()
                )
                  ? color
                  : undefined,
              }}
            >
              <Palette
                className={`w-3.5 h-3.5 ${
                  !PEN_COLORS.some((c) => c.hex.toLowerCase() === color.toLowerCase())
                    ? 'text-white drop-shadow'
                    : 'text-[#777777]'
                }`}
              />
              <input
                type="color"
                disabled={disabled}
                value={color}
                onChange={(e) => {
                  setColor(e.target.value);
                  setTool('pen');
                }}
                aria-label="اختيار لون مخصص"
                className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
              />
            </label>
          </div>

          {/* Pen & Eraser Width Presets + Continuous Slider */}
          <div className="flex flex-wrap items-center gap-1.5 bg-white border-2 border-[#E5E5E5] rounded-xl px-2 py-1">
            <div className="flex items-center gap-1">
              {PEN_SIZES.map((p) => {
                const active = penSize === p.size && tool !== 'pan';
                return (
                  <button
                    key={p.size}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setPenSize(p.size);
                      if (tool === 'pan') setTool('pen');
                    }}
                    title={`${p.label} (${p.size}px)`}
                    className={`px-1.5 sm:px-2 py-1 rounded-lg text-[11px] font-extrabold transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                      active
                        ? 'bg-[#D7FFB8] text-[#46A302] ring-1 ring-[#58CC02]'
                        : 'text-[#777777] hover:bg-[#F7F7F7]'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1.5 pr-1.5 border-r border-[#E5E5E5]">
              <span
                className="w-5 h-5 rounded-md bg-[#F7F7F7] border border-[#E5E5E5] flex items-center justify-center shrink-0"
                title={`سمك الخط الحالي: ${penSize}`}
              >
                <span
                  className="rounded-full block transition-all"
                  style={{
                    width: `${Math.max(3, Math.min(18, Math.round(penSize * 0.65)))}px`,
                    height: `${Math.max(3, Math.min(18, Math.round(penSize * 0.65)))}px`,
                    backgroundColor: tool === 'eraser' ? '#9CA3AF' : color,
                  }}
                />
              </span>
              <input
                type="range"
                min={1}
                max={36}
                step={1}
                disabled={disabled}
                value={penSize}
                onChange={(e) => {
                  setPenSize(Number(e.target.value));
                  if (tool === 'pan') setTool('pen');
                }}
                aria-label="التحكم في سمك الخط"
                className="w-20 sm:w-24 accent-[#58CC02] cursor-pointer disabled:opacity-50"
              />
              <span className="font-latin text-[11px] font-black text-[#3C3C3C] min-w-[26px] text-center">
                {penSize}px
              </span>
            </div>
          </div>

          {/* Pen / Eraser / Undo / Clear */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setTool('pen')}
              className={`duo-btn flex items-center gap-1 px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-xl border-2 border-b-4 text-[11px] sm:text-xs font-extrabold whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                tool === 'pen'
                  ? 'bg-[#1CB0F6] border-[#1899D6] text-white'
                  : 'bg-white border-[#E5E5E5] text-[#3C3C3C] hover:bg-[#F7F7F7]'
              }`}
            >
              <PenTool className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span>قلم</span>
            </button>

            <button
              type="button"
              disabled={disabled}
              onClick={() => setTool('eraser')}
              className={`duo-btn flex items-center gap-1 px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-xl border-2 border-b-4 text-[11px] sm:text-xs font-extrabold whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                tool === 'eraser'
                  ? 'bg-[#FFC800] border-[#E5A400] text-[#3C3C3C]'
                  : 'bg-white border-[#E5E5E5] text-[#3C3C3C] hover:bg-[#F7F7F7]'
              }`}
            >
              <Eraser className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span>مسّاحة</span>
            </button>

            <button
              type="button"
              disabled={disabled || strokes.length === 0}
              onClick={handleUndo}
              title="تراجع"
              className="duo-btn flex items-center gap-1 px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[11px] sm:text-xs font-extrabold text-[#3C3C3C] hover:bg-[#F7F7F7] whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40"
            >
              <RotateCcw className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span>تراجع</span>
            </button>

            <button
              type="button"
              disabled={disabled || strokes.length === 0}
              onClick={handleClear}
              title="مسح السبورة"
              className="duo-btn flex items-center gap-1 px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[11px] sm:text-xs font-extrabold text-[#EA2B2B] hover:bg-[#FFDFE0] whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40"
            >
              <Trash2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span className="sm:hidden">مسح</span>
              <span className="hidden sm:inline">مسح الكل</span>
            </button>
          </div>
        </div>
        )}

        {/* Zoom & Pan Controls */}
        <div className="flex items-center gap-1 bg-white border-2 border-[#E5E5E5] rounded-xl px-1.5 sm:px-2 py-1">
          <button
            type="button"
            onClick={() => setTool(tool === 'pan' ? 'pen' : 'pan')}
            title="تحريك اللوحة"
            className={`p-1.5 rounded-lg text-xs font-extrabold flex items-center gap-1 cursor-pointer ${
              tool === 'pan'
                ? 'bg-[#DDF4FF] text-[#1899D6]'
                : 'text-[#777777] hover:bg-[#F7F7F7]'
            }`}
          >
            <Hand className="w-4 h-4" />
            <span className="hidden sm:inline">تحريك</span>
          </button>

          <button
            type="button"
            onClick={handleZoomOut}
            title="تصغير"
            className="p-1.5 rounded-lg text-[#3C3C3C] hover:bg-[#F7F7F7] cursor-pointer"
          >
            <ZoomOut className="w-4 h-4" />
          </button>

          <span className="font-latin text-[11px] sm:text-xs font-extrabold text-[#3C3C3C] min-w-[38px] sm:min-w-[44px] text-center">
            {Math.round(zoom * 100)}%
          </span>

          <button
            type="button"
            onClick={handleZoomIn}
            title="تكبير"
            className="p-1.5 rounded-lg text-[#3C3C3C] hover:bg-[#F7F7F7] cursor-pointer"
          >
            <ZoomIn className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={handleResetView}
            title="إعادة الحجم الافتراضي"
            className="p-1.5 rounded-lg text-[#777777] hover:bg-[#F7F7F7] cursor-pointer"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Whiteboard Viewport */}
      <div
        ref={viewportRef}
        onWheel={handleWheelZoom}
        className={`relative w-full ${heightClass} rounded-2xl border-2 border-[#E5E5E5] border-b-4 whiteboard-grid overflow-hidden flex items-center justify-center touch-none select-none`}
      >
        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
            transition: isPanningRef.current || pinchStartRef.current ? 'none' : 'transform 0.12s ease-out',
            containerType: 'size',
          }}
          className="w-full h-full flex items-center justify-center p-1 sm:p-2"
        >
          <div
            style={{
              width: 'min(100cqw, calc(100cqh * 12 / 7))',
              height: 'min(100cqh, calc(100cqw * 7 / 12))',
            }}
            className="relative bg-white rounded-xl border-2 border-[#E5E5E5] shadow-sm overflow-hidden shrink-0"
          >
            {backgroundImage && (
              <img
                src={backgroundImage}
                alt="محتوى الصفحة"
                className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
              />
            )}
            <canvas
              ref={overlayCanvasRef}
              width={BOARD_WIDTH}
              height={BOARD_HEIGHT}
              className="absolute inset-0 w-full h-full pointer-events-none"
            />
            <canvas
              ref={committedCanvasRef}
              width={BOARD_WIDTH}
              height={BOARD_HEIGHT}
              className="absolute inset-0 w-full h-full pointer-events-none"
            />
            <canvas
              ref={canvasRef}
              width={BOARD_WIDTH}
              height={BOARD_HEIGHT}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishStroke}
              onPointerCancel={finishStroke}
              className={`relative z-[1] w-full h-full block bg-transparent touch-none ${
                tool === 'pan' || viewOnly
                  ? 'cursor-grab active:cursor-grabbing'
                  : disabled
                  ? 'cursor-not-allowed'
                  : 'cursor-crosshair'
              }`}
            />
          </div>
        </div>

        {/* Locked Overlay (Never shown in viewOnly Explain Mode so students see the live explanation clearly) */}
        {disabled && !viewOnly && (
          <div className="absolute inset-0 bg-white/75 backdrop-blur-[2px] flex flex-col items-center justify-center p-4 sm:p-6 text-center z-10">
            <DuoLockShield className="w-11 h-11 sm:w-14 sm:h-14 mb-2 sm:mb-3" />
            <p className="text-base sm:text-lg font-black text-[#3C3C3C] mb-1">{lockTitle}</p>
            <p className="text-xs sm:text-sm font-bold text-[#777777] max-w-md">{lockSubtitle}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export const ZoomablePreviewStage: React.FC<{
  imageSrc?: string;
  strokes?: Stroke[];
}> = ({ imageSrc, strokes }) => {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0, ox: 0, oy: 0 });
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{
    dist: number;
    zoom: number;
    midX: number;
    midY: number;
    ox: number;
    oy: number;
  } | null>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      draggingRef.current = false;
      const pts = Array.from(pointersRef.current.values()) as Array<{ x: number; y: number }>;
      pinchRef.current = {
        dist: Math.max(Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y), 10),
        zoom,
        midX: (pts[0].x + pts[1].x) / 2,
        midY: (pts[0].y + pts[1].y) / 2,
        ox: pan.x,
        oy: pan.y,
      };
      return;
    }
    draggingRef.current = true;
    startRef.current = { x: e.clientX, y: e.clientY, ox: pan.x, oy: pan.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pointersRef.current.size === 2 && pinchRef.current) {
      const pts = Array.from(pointersRef.current.values()) as Array<{ x: number; y: number }>;
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const p = pinchRef.current;
      setZoom(Math.max(0.5, Math.min(4.0, Number((p.zoom * (dist / p.dist)).toFixed(2)))));
      setPan({ x: p.ox + (midX - p.midX), y: p.oy + (midY - p.midY) });
      return;
    }
    if (!draggingRef.current) return;
    setPan({
      x: startRef.current.ox + (e.clientX - startRef.current.x),
      y: startRef.current.oy + (e.clientY - startRef.current.y),
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    draggingRef.current = false;
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-[#F7F7F7] border-2 border-[#E5E5E5] rounded-xl px-3 py-2">
        <span className="text-xs font-bold text-[#777777]">
          اسحب للتحريك أو استخدم أزرار التكبير والتصغير
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
            className="duo-btn p-1.5 rounded-lg bg-white border border-[#E5E5E5] text-[#3C3C3C] hover:bg-[#F0F0F0] cursor-pointer"
            title="تصغير"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="font-latin text-xs font-black text-[#3C3C3C] min-w-[44px] text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(4.0, Number((z + 0.25).toFixed(2))))}
            className="duo-btn p-1.5 rounded-lg bg-white border border-[#E5E5E5] text-[#3C3C3C] hover:bg-[#F0F0F0] cursor-pointer"
            title="تكبير"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            className="duo-btn px-2.5 py-1 rounded-lg bg-white border border-[#E5E5E5] text-xs font-black text-[#777777] hover:text-[#3C3C3C] cursor-pointer"
          >
            إعادة ضبط
          </button>
        </div>
      </div>

      <div
        onWheel={(e) => {
          e.preventDefault();
          const delta = e.deltaY < 0 ? 0.2 : -0.2;
          setZoom((z) => Math.max(0.5, Math.min(4.0, Number((z + delta).toFixed(2)))));
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="w-full h-[60dvh] sm:h-[70dvh] rounded-2xl border-2 border-[#E5E5E5] bg-[#F7F7F7] overflow-hidden flex items-center justify-center touch-none select-none cursor-grab active:cursor-grabbing"
      >
        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
          }}
          className="w-full h-full flex items-center justify-center p-2"
        >
          {strokes ? (
            <WhiteboardPreview
              strokes={strokes}
              backgroundImage={imageSrc}
              className="w-full max-w-3xl aspect-[12/7]"
            />
          ) : (
            <img
              src={imageSrc}
              alt="معاينة مكبرة"
              className="max-h-full max-w-full object-contain rounded-xl pointer-events-none select-none"
            />
          )}
        </div>
      </div>
    </div>
  );
};
