import React, { useMemo, useRef, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import type { FigureColor, FigureElement, FigureLabelPos, FigurePoint, QuizFigure } from '../types';
import { FIGURE_COLOR_MAP, formatFigureLabel } from '../quizFigure';

interface FigureViewProps {
  figure: QuizFigure;
  className?: string;
  compact?: boolean;
  allowZoom?: boolean;
  interactive?: boolean;
  editMode?: 'point' | 'shape';
  snapStep?: number;
  selectedElementIdx?: number | null;
  selectedPointId?: string | null;
  onSelectElement?: (idx: number) => void;
  onSelectPoint?: (id: string) => void;
  onMovePoint?: (pointId: string, x: number, y: number) => void;
  onMoveElement?: (elIdx: number, dx: number, dy: number) => void;
}

type Pt2 = { x: number; y: number };

interface ComputedLayout {
  ptsMap: Map<string, FigurePoint>;
  W: number;
  H: number;
  scale: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  offsetX: number;
  offsetY: number;
  sx: (x: number) => number;
  sy: (y: number) => number;
  centroidMath: Pt2;
  extendedEndpoints: Map<number, { p1: Pt2; p2: Pt2 }>;
  stepUnit: number;
}

type DragSession =
  | {
      kind: 'point';
      pointId: string;
      pointerId: number;
      startMath: Pt2;
      origPoint: Pt2;
    }
  | {
      kind: 'element';
      elIdx: number;
      pointerId: number;
      startMath: Pt2;
      lastOffset: Pt2;
    };

const FONT_STACK = "'Cairo', 'Nunito', system-ui, sans-serif";

function colorOf(c?: FigureColor | 'none'): { stroke: string; fill: string; text: string } {
  if (!c || c === 'none') return FIGURE_COLOR_MAP.ink;
  return FIGURE_COLOR_MAP[c] ?? FIGURE_COLOR_MAP.ink;
}

function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function normAngle(a: number): number {
  const twoPi = Math.PI * 2;
  return ((a % twoPi) + twoPi) % twoPi;
}

function unitVec(from: Pt2, to: Pt2): Pt2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: 1, y: 0 };
  return { x: dx / len, y: dy / len };
}

function labelOffsetFromPos(pos: FigureLabelPos | undefined, away: Pt2, dist = 16): Pt2 {
  switch (pos) {
    case 'top':
      return { x: 0, y: -dist };
    case 'bottom':
      return { x: 0, y: dist + 2 };
    case 'left':
      return { x: -dist - 2, y: 4 };
    case 'right':
      return { x: dist + 2, y: 4 };
    case 'top-left':
      return { x: -dist * 0.85, y: -dist * 0.85 };
    case 'top-right':
      return { x: dist * 0.85, y: -dist * 0.85 };
    case 'bottom-left':
      return { x: -dist * 0.85, y: dist * 0.95 };
    case 'bottom-right':
      return { x: dist * 0.85, y: dist * 0.95 };
    default:
      return { x: away.x * dist, y: -away.y * dist + 4 };
  }
}

function arrowHeadPoints(tip: Pt2, dirX: number, dirY: number, size = 9): string {
  // dir points into the tip in SVG coordinates
  const px = -dirY;
  const py = dirX;
  const bx = tip.x - dirX * size;
  const by = tip.y - dirY * size;
  const w = size * 0.44;
  return `${tip.x.toFixed(1)},${tip.y.toFixed(1)} ${(bx + px * w).toFixed(1)},${(by + py * w).toFixed(1)} ${(bx - px * w).toFixed(1)},${(by - py * w).toFixed(1)}`;
}

function chevronPoints(mid: Pt2, dirX: number, dirY: number, size = 6.5): string {
  const px = -dirY;
  const py = dirX;
  const tipX = mid.x + dirX * (size * 0.55);
  const tipY = mid.y + dirY * (size * 0.55);
  const backX = mid.x - dirX * (size * 0.55);
  const backY = mid.y - dirY * (size * 0.55);
  const wing = size * 0.72;
  return `${(backX + px * wing).toFixed(1)},${(backY + py * wing).toFixed(1)} ${tipX.toFixed(1)},${tipY.toFixed(1)} ${(backX - px * wing).toFixed(1)},${(backY - py * wing).toFixed(1)}`;
}

function roundSnap(v: number, snapStep: number): number {
  if (snapStep && snapStep > 0) {
    return Math.round(Math.round(v / snapStep) * snapStep * 1000) / 1000;
  }
  return Math.round(v * 100) / 100;
}

const HaloText: React.FC<React.SVGProps<SVGTextElement>> = ({ children, style, ...rest }) => (
  <text
    fontFamily={FONT_STACK}
    fontWeight={800}
    fontSize={13}
    paintOrder="stroke"
    stroke="#FFFFFF"
    strokeWidth={4.5}
    strokeLinejoin="round"
    strokeLinecap="round"
    style={{ userSelect: 'none', ...style }}
    {...rest}
  >
    {children}
  </text>
);

export const FigureView: React.FC<FigureViewProps> = ({
  figure,
  className = '',
  compact = false,
  allowZoom = true,
  interactive = false,
  editMode = 'shape',
  snapStep = 0.25,
  selectedElementIdx = null,
  selectedPointId = null,
  onSelectElement,
  onSelectPoint,
  onMovePoint,
  onMoveElement,
}) => {
  const [zoomed, setZoomed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragSession | null>(null);
  const frozenBoundsRef = useRef<{
    W: number;
    H: number;
    scale: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);

  const liveLayout = useMemo<ComputedLayout>(() => {
    const ptsMap = new Map<string, FigurePoint>();
    figure.points.forEach((p) => ptsMap.set(p.id, p));

    // 1) Collect base bounding box in mathematical Y-up coords
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    const expand = (x: number, y: number) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };

    figure.points.forEach((p) => expand(p.x, p.y));

    figure.elements.forEach((el) => {
      if (el.type === 'circle') {
        const c = ptsMap.get(el.center);
        if (c) {
          expand(c.x - el.r, c.y - el.r);
          expand(c.x + el.r, c.y + el.r);
        }
      } else if (el.type === 'arc') {
        const c = ptsMap.get(el.center);
        if (c) {
          expand(c.x, c.y);
          const a0 = rad(el.startDeg);
          const a1 = rad(el.endDeg);
          expand(c.x + el.r * Math.cos(a0), c.y + el.r * Math.sin(a0));
          expand(c.x + el.r * Math.cos(a1), c.y + el.r * Math.sin(a1));
          [0, 90, 180, 270].forEach((deg) => {
            const s = normAngle(a0);
            const e = normAngle(a1);
            const t = normAngle(rad(deg));
            const span = normAngle(e - s);
            const d = normAngle(t - s);
            if (d <= span + 1e-6 || Math.abs(el.endDeg - el.startDeg) >= 360) {
              expand(c.x + el.r * Math.cos(t), c.y + el.r * Math.sin(t));
            }
          });
        }
      } else if (el.type === 'label') {
        expand(el.x, el.y);
      }
    });

    if (!Number.isFinite(minX)) {
      minX = -4;
      maxX = 4;
      minY = -3;
      maxY = 3;
    }

    let spanX = Math.max(1e-3, maxX - minX);
    let spanY = Math.max(1e-3, maxY - minY);
    const baseScale = Math.max(spanX, spanY, 2);

    // 2) Extend rays/lines slightly beyond base bounding box cleanly
    const extLen = baseScale * 0.22;
    const extendedEndpoints = new Map<number, { p1: Pt2; p2: Pt2 }>();
    figure.elements.forEach((el, idx) => {
      if (el.type !== 'segment' || (!el.extendFrom && !el.extendTo)) return;
      const a = ptsMap.get(el.from);
      const b = ptsMap.get(el.to);
      if (!a || !b) return;
      const u = unitVec(a, b);
      const p1 = el.extendFrom ? { x: a.x - u.x * extLen, y: a.y - u.y * extLen } : { x: a.x, y: a.y };
      const p2 = el.extendTo ? { x: b.x + u.x * extLen, y: b.y + u.y * extLen } : { x: b.x, y: b.y };
      extendedEndpoints.set(idx, { p1, p2 });
      expand(p1.x, p1.y);
      expand(p2.x, p2.y);
    });

    spanX = Math.max(1e-3, maxX - minX);
    spanY = Math.max(1e-3, maxY - minY);

    const W = 540;
    const padX = 52;
    const padY = 46;
    const ratio = spanY / spanX;
    const targetInnerW = W - padX * 2;
    const rawH = Math.round(targetInnerW * ratio + padY * 2);
    const H = Math.max(250, Math.min(410, rawH));

    const innerW = W - padX * 2;
    const innerH = H - padY * 2;
    const scale = Math.min(innerW / spanX, innerH / spanY);

    const drawW = spanX * scale;
    const drawH = spanY * scale;
    const offsetX = (W - drawW) / 2;
    const offsetY = (H - drawH) / 2;

    const sx = (x: number) => offsetX + (x - minX) * scale;
    const sy = (y: number) => offsetY + (maxY - y) * scale;

    const centroidMath: Pt2 =
      figure.points.length > 0
        ? {
            x: figure.points.reduce((s, p) => s + p.x, 0) / figure.points.length,
            y: figure.points.reduce((s, p) => s + p.y, 0) / figure.points.length,
          }
        : { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

    const roughStep = Math.max(spanX, spanY) / 8;
    const pow10 = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const norm = roughStep / pow10;
    const stepUnit = (norm <= 1.2 ? 1 : norm <= 2.5 ? 2 : norm <= 5 ? 5 : 10) * pow10;

    return {
      ptsMap,
      W,
      H,
      scale,
      minX,
      maxX,
      minY,
      maxY,
      offsetX,
      offsetY,
      sx,
      sy,
      centroidMath,
      extendedEndpoints,
      stepUnit,
    };
  }, [figure]);

  // While actively dragging on canvas, freeze the projection so shapes move 1:1 under the cursor
  const activeBounds = isDragging && frozenBoundsRef.current ? frozenBoundsRef.current : liveLayout;
  const W = activeBounds.W;
  const H = activeBounds.H;
  const scale = activeBounds.scale;
  const minX = activeBounds.minX;
  const maxX = activeBounds.maxX;
  const minY = activeBounds.minY;
  const maxY = activeBounds.maxY;
  const offsetX = activeBounds.offsetX;
  const offsetY = activeBounds.offsetY;
  const sx = (x: number) => offsetX + (x - minX) * scale;
  const sy = (y: number) => offsetY + (maxY - y) * scale;

  const { ptsMap, centroidMath, extendedEndpoints, stepUnit } = liveLayout;

  const clientToMath = (clientX: number, clientY: number): Pt2 | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const bounds = frozenBoundsRef.current || activeBounds;
    const meetScale = Math.min(rect.width / bounds.W, rect.height / bounds.H);
    const viewLeft = rect.left + (rect.width - bounds.W * meetScale) / 2;
    const viewTop = rect.top + (rect.height - bounds.H * meetScale) / 2;
    const svgX = (clientX - viewLeft) / meetScale;
    const svgY = (clientY - viewTop) / meetScale;
    return {
      x: bounds.minX + (svgX - bounds.offsetX) / bounds.scale,
      y: bounds.maxY - (svgY - bounds.offsetY) / bounds.scale,
    };
  };

  const freezeBounds = () => {
    frozenBoundsRef.current = {
      W: liveLayout.W,
      H: liveLayout.H,
      scale: liveLayout.scale,
      minX: liveLayout.minX,
      maxX: liveLayout.maxX,
      minY: liveLayout.minY,
      maxY: liveLayout.maxY,
      offsetX: liveLayout.offsetX,
      offsetY: liveLayout.offsetY,
    };
  };

  const startPointDrag = (e: React.PointerEvent, p: FigurePoint) => {
    if (!interactive) return;
    e.stopPropagation();
    e.preventDefault();
    onSelectPoint?.(p.id);
    if (!onMovePoint) return;
    freezeBounds();
    const m = clientToMath(e.clientX, e.clientY);
    if (!m) return;
    dragRef.current = {
      kind: 'point',
      pointId: p.id,
      pointerId: e.pointerId,
      startMath: m,
      origPoint: { x: p.x, y: p.y },
    };
    setIsDragging(true);
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // ignore if pointer capture unavailable
    }
  };

  const startElementInteraction = (e: React.PointerEvent, idx: number, draggable = true) => {
    if (!interactive) return;
    e.stopPropagation();
    onSelectElement?.(idx);
    if (editMode !== 'shape' || !draggable || !onMoveElement) return;
    e.preventDefault();
    freezeBounds();
    const m = clientToMath(e.clientX, e.clientY);
    if (!m) return;
    dragRef.current = {
      kind: 'element',
      elIdx: idx,
      pointerId: e.pointerId,
      startMath: m,
      lastOffset: { x: 0, y: 0 },
    };
    setIsDragging(true);
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const sess = dragRef.current;
    if (!sess || !interactive) return;
    const m = clientToMath(e.clientX, e.clientY);
    if (!m) return;

    if (sess.kind === 'point' && onMovePoint) {
      const dx = m.x - sess.startMath.x;
      const dy = m.y - sess.startMath.y;
      const nx = roundSnap(sess.origPoint.x + dx, snapStep);
      const ny = roundSnap(sess.origPoint.y + dy, snapStep);
      onMovePoint(sess.pointId, nx, ny);
      return;
    }

    if (sess.kind === 'element' && onMoveElement) {
      const rawDx = m.x - sess.startMath.x;
      const rawDy = m.y - sess.startMath.y;
      const targetDx = roundSnap(rawDx, snapStep);
      const targetDy = roundSnap(rawDy, snapStep);
      const stepDx = Math.round((targetDx - sess.lastOffset.x) * 1000) / 1000;
      const stepDy = Math.round((targetDy - sess.lastOffset.y) * 1000) / 1000;
      if (stepDx !== 0 || stepDy !== 0) {
        sess.lastOffset = { x: targetDx, y: targetDy };
        onMoveElement(sess.elIdx, stepDx, stepDy);
      }
    }
  };

  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    frozenBoundsRef.current = null;
    setIsDragging(false);
    try {
      if (svgRef.current?.hasPointerCapture(e.pointerId)) {
        svgRef.current.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
  };

  const renderTicksSvg = (
    p1Svg: Pt2,
    p2Svg: Pt2,
    count: number,
    stroke: string,
    keyPrefix: string
  ) => {
    if (!count || count <= 0) return null;
    const u = unitVec(p1Svg, p2Svg);
    const perp = { x: -u.y, y: u.x };
    const mx = (p1Svg.x + p2Svg.x) / 2;
    const my = (p1Svg.y + p2Svg.y) / 2;
    const spacing = 5;
    const halfTick = 6.5;
    const items: React.ReactNode[] = [];
    for (let i = 0; i < count; i++) {
      const shift = (i - (count - 1) / 2) * spacing;
      const cx = mx + u.x * shift;
      const cy = my + u.y * shift;
      items.push(
        <line
          key={`${keyPrefix}-tk-${i}`}
          x1={cx - perp.x * halfTick}
          y1={cy - perp.y * halfTick}
          x2={cx + perp.x * halfTick}
          y2={cy + perp.y * halfTick}
          stroke={stroke}
          strokeWidth={2.2}
          strokeLinecap="round"
        />
      );
    }
    return items;
  };

  const renderElement = (el: FigureElement, idx: number, allowInteractive: boolean) => {
    const isSelected = allowInteractive && selectedElementIdx === idx;
    const shapeCursor =
      allowInteractive && editMode === 'shape' ? 'grab' : allowInteractive ? 'pointer' : undefined;

    if (el.type === 'polygon') {
      const pts = el.points.map((id) => ptsMap.get(id)).filter((p): p is FigurePoint => !!p);
      if (pts.length < 3) return null;
      const svgPts = pts.map((p) => ({ x: sx(p.x), y: sy(p.y) }));
      const pointsAttr = svgPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      const strokeMeta = colorOf(el.stroke ?? 'ink');
      const hasFill = el.fill && el.fill !== 'none';
      const fillMeta = hasFill ? colorOf(el.fill) : null;
      const fillOpacity = el.fill === 'white' ? 1 : el.fillOpacity ?? 0.16;

      const polyCenter: Pt2 = {
        x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
        y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
      };

      return (
        <g
          key={`poly-${idx}`}
          style={{ cursor: shapeCursor }}
          onPointerDown={allowInteractive ? (e) => startElementInteraction(e, idx, true) : undefined}
        >
          {isSelected && (
            <polygon
              points={pointsAttr}
              fill="none"
              stroke="#A560E8"
              strokeWidth={6}
              strokeOpacity={0.35}
              strokeLinejoin="round"
              pointerEvents="none"
            />
          )}
          <polygon
            points={pointsAttr}
            fill={fillMeta ? fillMeta.fill : allowInteractive ? '#FFFFFF' : 'none'}
            fillOpacity={hasFill ? fillOpacity : allowInteractive ? 0.001 : undefined}
            stroke={strokeMeta.stroke}
            strokeWidth={2.6}
            strokeLinejoin="round"
            strokeDasharray={el.dashed ? '6 5' : undefined}
          />
          {svgPts.map((sp, i) => {
            const nextIdx = (i + 1) % svgPts.length;
            const np = svgPts[nextIdx];
            const tickCount = el.ticks?.[i] ?? 0;
            const rawSide = el.sideLabels?.[i];
            const sideText = rawSide ? formatFigureLabel(rawSide) : '';

            let sideLabelNode: React.ReactNode = null;
            if (sideText) {
              const midX = (sp.x + np.x) / 2;
              const midY = (sp.y + np.y) / 2;
              const dx = np.x - sp.x;
              const dy = np.y - sp.y;
              const len = Math.hypot(dx, dy) || 1;
              let nx = -dy / len;
              let ny = dx / len;
              const pcSvg = { x: sx(polyCenter.x), y: sy(polyCenter.y) };
              if ((midX - pcSvg.x) * nx + (midY - pcSvg.y) * ny < 0) {
                nx = -nx;
                ny = -ny;
              }
              const offset = 15;
              sideLabelNode = (
                <HaloText
                  x={midX + nx * offset}
                  y={midY + ny * offset + 4}
                  textAnchor="middle"
                  fill={strokeMeta.text}
                  fontSize={12.5}
                >
                  {sideText}
                </HaloText>
              );
            }

            return (
              <g key={`poly-${idx}-edge-${i}`}>
                {tickCount > 0 && renderTicksSvg(sp, np, tickCount, strokeMeta.stroke, `poly-${idx}-${i}`)}
                {sideLabelNode}
              </g>
            );
          })}
        </g>
      );
    }

    if (el.type === 'segment') {
      const a = ptsMap.get(el.from);
      const b = ptsMap.get(el.to);
      if (!a || !b) return null;
      const ext = extendedEndpoints.get(idx);
      const p1Math = ext ? ext.p1 : { x: a.x, y: a.y };
      const p2Math = ext ? ext.p2 : { x: b.x, y: b.y };
      const p1Svg = { x: sx(p1Math.x), y: sy(p1Math.y) };
      const p2Svg = { x: sx(p2Math.x), y: sy(p2Math.y) };
      const aSvg = { x: sx(a.x), y: sy(a.y) };
      const bSvg = { x: sx(b.x), y: sy(b.y) };
      const uSvg = unitVec(p1Svg, p2Svg);
      const cMeta = colorOf(el.stroke ?? 'ink');

      const midX = (aSvg.x + bSvg.x) / 2;
      const midY = (aSvg.y + bSvg.y) / 2;
      const labelText = el.label ? formatFigureLabel(el.label) : '';

      const parallelChevrons: React.ReactNode[] = [];
      if (el.parallel && el.parallel > 0) {
        const chMid = {
          x: aSvg.x + (bSvg.x - aSvg.x) * 0.28,
          y: aSvg.y + (bSvg.y - aSvg.y) * 0.28,
        };
        for (let k = 0; k < el.parallel; k++) {
          const shift = (k - (el.parallel - 1) / 2) * 7;
          parallelChevrons.push(
            <polyline
              key={`par-${idx}-${k}`}
              points={chevronPoints(
                { x: chMid.x + uSvg.x * shift, y: chMid.y + uSvg.y * shift },
                uSvg.x,
                uSvg.y
              )}
              fill="none"
              stroke={cMeta.stroke}
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        }
      }

      let labelX = midX;
      let labelY = midY - 12;
      if (labelText) {
        let nx = -uSvg.y;
        let ny = uSvg.x;
        const cSvg = { x: sx(centroidMath.x), y: sy(centroidMath.y) };
        if ((midX - cSvg.x) * nx + (midY - cSvg.y) * ny < 0) {
          nx = -nx;
          ny = -ny;
        }
        labelX = midX + nx * 14;
        labelY = midY + ny * 14 + 4;
      }

      return (
        <g
          key={`seg-${idx}`}
          style={{ cursor: shapeCursor }}
          onPointerDown={allowInteractive ? (e) => startElementInteraction(e, idx, true) : undefined}
        >
          {allowInteractive && (
            <line
              x1={p1Svg.x}
              y1={p1Svg.y}
              x2={p2Svg.x}
              y2={p2Svg.y}
              stroke="transparent"
              strokeWidth={14}
              strokeLinecap="round"
            />
          )}
          {isSelected && (
            <line
              x1={p1Svg.x}
              y1={p1Svg.y}
              x2={p2Svg.x}
              y2={p2Svg.y}
              stroke="#A560E8"
              strokeWidth={7}
              strokeOpacity={0.35}
              strokeLinecap="round"
              pointerEvents="none"
            />
          )}
          <line
            x1={p1Svg.x}
            y1={p1Svg.y}
            x2={p2Svg.x}
            y2={p2Svg.y}
            stroke={cMeta.stroke}
            strokeWidth={2.6}
            strokeLinecap="round"
            strokeDasharray={el.dashed ? '6 5' : undefined}
          />
          {el.extendFrom && (
            <polygon points={arrowHeadPoints(p1Svg, -uSvg.x, -uSvg.y)} fill={cMeta.stroke} />
          )}
          {el.extendTo && (
            <polygon points={arrowHeadPoints(p2Svg, uSvg.x, uSvg.y)} fill={cMeta.stroke} />
          )}
          {el.ticks && el.ticks > 0 && renderTicksSvg(aSvg, bSvg, el.ticks, cMeta.stroke, `seg-${idx}`)}
          {parallelChevrons}
          {labelText && (
            <HaloText x={labelX} y={labelY} textAnchor="middle" fill={cMeta.text} fontSize={12.5}>
              {labelText}
            </HaloText>
          )}
        </g>
      );
    }

    if (el.type === 'circle') {
      const c = ptsMap.get(el.center);
      if (!c) return null;
      const cx = sx(c.x);
      const cy = sy(c.y);
      const rSvg = el.r * scale;
      const strokeMeta = colorOf(el.stroke ?? 'ink');
      const hasFill = el.fill && el.fill !== 'none';
      const fillMeta = hasFill ? colorOf(el.fill) : null;
      const fillOpacity = el.fill === 'white' ? 1 : el.fillOpacity ?? 0.16;

      const rDeg = el.radiusAngleDeg ?? (el.radiusLabel ? 0 : undefined);
      const rEdge =
        rDeg !== undefined
          ? {
              x: sx(c.x + el.r * Math.cos(rad(rDeg))),
              y: sy(c.y + el.r * Math.sin(rad(rDeg))),
            }
          : null;

      const dDeg = el.diameterAngleDeg ?? (el.diameterLabel ? 0 : undefined);
      const dEdgeA =
        dDeg !== undefined
          ? {
              x: sx(c.x - el.r * Math.cos(rad(dDeg))),
              y: sy(c.y - el.r * Math.sin(rad(dDeg))),
            }
          : null;
      const dEdgeB =
        dDeg !== undefined
          ? {
              x: sx(c.x + el.r * Math.cos(rad(dDeg))),
              y: sy(c.y + el.r * Math.sin(rad(dDeg))),
            }
          : null;

      return (
        <g
          key={`circ-${idx}`}
          style={{ cursor: shapeCursor }}
          onPointerDown={allowInteractive ? (e) => startElementInteraction(e, idx, true) : undefined}
        >
          {isSelected && (
            <circle
              cx={cx}
              cy={cy}
              r={rSvg + 4}
              fill="none"
              stroke="#A560E8"
              strokeWidth={4}
              strokeOpacity={0.4}
              strokeDasharray="6 4"
              pointerEvents="none"
            />
          )}
          <circle
            cx={cx}
            cy={cy}
            r={rSvg}
            fill={fillMeta ? fillMeta.fill : allowInteractive ? '#FFFFFF' : 'none'}
            fillOpacity={hasFill ? fillOpacity : allowInteractive ? 0.001 : undefined}
            stroke={strokeMeta.stroke}
            strokeWidth={2.6}
            strokeDasharray={el.dashed ? '6 5' : undefined}
          />
          {dEdgeA && dEdgeB && (
            <g>
              <line
                x1={dEdgeA.x}
                y1={dEdgeA.y}
                x2={dEdgeB.x}
                y2={dEdgeB.y}
                stroke={strokeMeta.stroke}
                strokeWidth={2.1}
                strokeDasharray="5 4"
              />
              {el.diameterLabel && (
                <HaloText
                  x={cx}
                  y={cy - 10}
                  textAnchor="middle"
                  fill={strokeMeta.text}
                  fontSize={12.5}
                >
                  {formatFigureLabel(el.diameterLabel)}
                </HaloText>
              )}
            </g>
          )}
          {rEdge && (
            <g>
              <line
                x1={cx}
                y1={cy}
                x2={rEdge.x}
                y2={rEdge.y}
                stroke={strokeMeta.stroke}
                strokeWidth={2.1}
                strokeDasharray="5 4"
              />
              {el.radiusLabel && (
                <HaloText
                  x={(cx + rEdge.x) / 2}
                  y={(cy + rEdge.y) / 2 - 8}
                  textAnchor="middle"
                  fill={strokeMeta.text}
                  fontSize={12.5}
                >
                  {formatFigureLabel(el.radiusLabel)}
                </HaloText>
              )}
            </g>
          )}
          {el.showCenter && (
            <circle cx={cx} cy={cy} r={4} fill={strokeMeta.stroke} stroke="#FFFFFF" strokeWidth={1.5} />
          )}
        </g>
      );
    }

    if (el.type === 'arc') {
      const c = ptsMap.get(el.center);
      if (!c) return null;
      const cx = sx(c.x);
      const cy = sy(c.y);
      const rSvg = el.r * scale;
      const a0 = rad(el.startDeg);
      const a1 = rad(el.endDeg);
      let span = normAngle(a1 - a0);
      if (Math.abs(el.endDeg - el.startDeg) >= 360) span = Math.PI * 2 - 1e-4;
      const p0 = { x: cx + rSvg * Math.cos(a0), y: cy - rSvg * Math.sin(a0) };
      const p1 = { x: cx + rSvg * Math.cos(a0 + span), y: cy - rSvg * Math.sin(a0 + span) };
      const large = span > Math.PI ? 1 : 0;
      const d = el.sector
        ? `M ${cx.toFixed(1)} ${cy.toFixed(1)} L ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} A ${rSvg.toFixed(1)} ${rSvg.toFixed(1)} 0 ${large} 0 ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} Z`
        : `M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} A ${rSvg.toFixed(1)} ${rSvg.toFixed(1)} 0 ${large} 0 ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;

      const strokeMeta = colorOf(el.stroke ?? 'blue');
      const hasFill = el.fill && el.fill !== 'none';
      const fillMeta = hasFill ? colorOf(el.fill) : null;
      const fillOpacity = el.fill === 'white' ? 1 : el.fillOpacity ?? (el.sector ? 0.3 : 0);
      const midA = a0 + span / 2;
      const labelDist = el.sector ? rSvg * 0.65 : rSvg + 15;
      const lx = cx + labelDist * Math.cos(midA);
      const ly = cy - labelDist * Math.sin(midA) + 4;

      return (
        <g
          key={`arc-${idx}`}
          style={{ cursor: shapeCursor }}
          onPointerDown={allowInteractive ? (e) => startElementInteraction(e, idx, true) : undefined}
        >
          {isSelected && (
            <path
              d={d}
              fill="none"
              stroke="#A560E8"
              strokeWidth={6}
              strokeOpacity={0.38}
              strokeLinejoin="round"
              pointerEvents="none"
            />
          )}
          <path
            d={d}
            fill={fillMeta ? fillMeta.fill : 'none'}
            fillOpacity={hasFill ? fillOpacity : undefined}
            stroke={strokeMeta.stroke}
            strokeWidth={2.5}
            strokeDasharray={el.dashed ? '6 5' : undefined}
            strokeLinejoin="round"
          />
          {el.label && (
            <HaloText x={lx} y={ly} textAnchor="middle" fill={strokeMeta.text} fontSize={12.5}>
              {formatFigureLabel(el.label)}
            </HaloText>
          )}
        </g>
      );
    }

    if (el.type === 'angle') {
      const a = ptsMap.get(el.a);
      const v = ptsMap.get(el.vertex);
      const b = ptsMap.get(el.b);
      if (!a || !v || !b) return null;
      const vx = sx(v.x);
      const vy = sy(v.y);

      const angA = Math.atan2(a.y - v.y, a.x - v.x);
      const angB = Math.atan2(b.y - v.y, b.x - v.x);
      let start = angA;
      let span = normAngle(angB - angA);
      if (el.reflex) {
        if (span <= Math.PI) {
          start = angB;
          span = Math.PI * 2 - span;
        }
      } else {
        if (span > Math.PI) {
          start = angB;
          span = Math.PI * 2 - span;
        }
      }
      if (span < 1e-4) return null;

      const cMeta = colorOf(el.color ?? 'blue');
      const maxArmSvg = Math.min(
        Math.hypot(sx(a.x) - vx, sy(a.y) - vy),
        Math.hypot(sx(b.x) - vx, sy(b.y) - vy)
      );
      const baseRSvg = el.r
        ? Math.min(el.r * scale, Math.max(18, maxArmSvg * 0.7))
        : Math.max(20, Math.min(34, maxArmSvg * 0.34));

      if (el.right) {
        const sq = Math.max(12, Math.min(20, maxArmSvg * 0.26));
        const u1 = { x: Math.cos(start), y: -Math.sin(start) };
        const endA = start + span;
        const u2 = { x: Math.cos(endA), y: -Math.sin(endA) };
        const p1 = { x: vx + u1.x * sq, y: vy + u1.y * sq };
        const p2 = { x: vx + (u1.x + u2.x) * sq, y: vy + (u1.y + u2.y) * sq };
        const p3 = { x: vx + u2.x * sq, y: vy + u2.y * sq };
        const midAng = start + span / 2;
        const labelR = sq * 1.45 + 10;

        return (
          <g
            key={`ang-${idx}`}
            style={{ cursor: allowInteractive ? 'pointer' : undefined }}
            onPointerDown={allowInteractive ? (e) => startElementInteraction(e, idx, false) : undefined}
          >
            <polygon
              points={`${vx},${vy} ${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`}
              fill={cMeta.fill}
              fillOpacity={isSelected ? 0.55 : 0.35}
            />
            <polyline
              points={`${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`}
              fill="none"
              stroke={isSelected ? '#A560E8' : cMeta.stroke}
              strokeWidth={isSelected ? 3 : 2.2}
              strokeLinejoin="round"
            />
            {el.label && (
              <HaloText
                x={vx + labelR * Math.cos(midAng)}
                y={vy - labelR * Math.sin(midAng) + 4}
                textAnchor="middle"
                fill={cMeta.text}
                fontSize={12.5}
              >
                {formatFigureLabel(el.label)}
              </HaloText>
            )}
          </g>
        );
      }

      const arcCount = Math.max(1, Math.min(3, el.arcs ?? 1));
      const large = span > Math.PI ? 1 : 0;
      const sectorP0 = {
        x: vx + baseRSvg * Math.cos(start),
        y: vy - baseRSvg * Math.sin(start),
      };
      const sectorP1 = {
        x: vx + baseRSvg * Math.cos(start + span),
        y: vy - baseRSvg * Math.sin(start + span),
      };
      const sectorD = `M ${vx.toFixed(1)} ${vy.toFixed(1)} L ${sectorP0.x.toFixed(1)} ${sectorP0.y.toFixed(1)} A ${baseRSvg.toFixed(1)} ${baseRSvg.toFixed(1)} 0 ${large} 0 ${sectorP1.x.toFixed(1)} ${sectorP1.y.toFixed(1)} Z`;

      const arcPaths: React.ReactNode[] = [];
      for (let k = 0; k < arcCount; k++) {
        const rk = baseRSvg + k * 4.5;
        const ap0 = { x: vx + rk * Math.cos(start), y: vy - rk * Math.sin(start) };
        const ap1 = { x: vx + rk * Math.cos(start + span), y: vy - rk * Math.sin(start + span) };
        arcPaths.push(
          <path
            key={`ang-${idx}-a-${k}`}
            d={`M ${ap0.x.toFixed(1)} ${ap0.y.toFixed(1)} A ${rk.toFixed(1)} ${rk.toFixed(1)} 0 ${large} 0 ${ap1.x.toFixed(1)} ${ap1.y.toFixed(1)}`}
            fill="none"
            stroke={isSelected ? '#A560E8' : cMeta.stroke}
            strokeWidth={isSelected ? 3 : 2.2}
            strokeLinecap="round"
          />
        );
      }

      const midAng = start + span / 2;
      const outerR = baseRSvg + (arcCount - 1) * 4.5;
      const acuteBoost = span < 0.7 ? 20 : span < 1.1 ? 15 : 13;
      const labelDist = outerR + acuteBoost;
      const lx = vx + labelDist * Math.cos(midAng);
      const ly = vy - labelDist * Math.sin(midAng) + 4.5;

      return (
        <g
          key={`ang-${idx}`}
          style={{ cursor: allowInteractive ? 'pointer' : undefined }}
          onPointerDown={allowInteractive ? (e) => startElementInteraction(e, idx, false) : undefined}
        >
          <path d={sectorD} fill={cMeta.fill} fillOpacity={isSelected ? 0.36 : 0.22} />
          {arcPaths}
          {el.label && (
            <HaloText x={lx} y={ly} textAnchor="middle" fill={cMeta.text} fontSize={13}>
              {formatFigureLabel(el.label)}
            </HaloText>
          )}
        </g>
      );
    }

    if (el.type === 'label') {
      const cMeta = colorOf(el.color ?? 'ink');
      const lx = sx(el.x);
      const ly = sy(el.y) + 4;
      return (
        <g
          key={`lbl-${idx}`}
          style={{ cursor: shapeCursor }}
          onPointerDown={allowInteractive ? (e) => startElementInteraction(e, idx, true) : undefined}
        >
          {isSelected && (
            <circle
              cx={lx}
              cy={ly - 4}
              r={16}
              fill="#A560E8"
              fillOpacity={0.14}
              stroke="#A560E8"
              strokeWidth={1.5}
              strokeDasharray="3 3"
              pointerEvents="none"
            />
          )}
          <HaloText x={lx} y={ly} textAnchor="middle" fill={cMeta.text} fontSize={13}>
            {formatFigureLabel(el.text)}
          </HaloText>
        </g>
      );
    }

    return null;
  };

  const renderGridLines = () => {
    if (!figure.grid) return null;
    const xStart = Math.floor(minX / stepUnit) * stepUnit;
    const xEnd = Math.ceil(maxX / stepUnit) * stepUnit;
    const yStart = Math.floor(minY / stepUnit) * stepUnit;
    const yEnd = Math.ceil(maxY / stepUnit) * stepUnit;
    const lines: React.ReactNode[] = [];
    for (let x = xStart; x <= xEnd + 1e-6; x += stepUnit) {
      const rx = sx(x);
      const isAxis = Math.abs(x) < 1e-5;
      lines.push(
        <line
          key={`gx-${x.toFixed(2)}`}
          x1={rx}
          y1={0}
          x2={rx}
          y2={H}
          stroke={isAxis ? '#CBD5E1' : '#F0F0F0'}
          strokeWidth={isAxis ? 1.5 : 1}
        />
      );
    }
    for (let y = yStart; y <= yEnd + 1e-6; y += stepUnit) {
      const ry = sy(y);
      const isAxis = Math.abs(y) < 1e-5;
      lines.push(
        <line
          key={`gy-${y.toFixed(2)}`}
          x1={0}
          y1={ry}
          x2={W}
          y2={ry}
          stroke={isAxis ? '#CBD5E1' : '#F0F0F0'}
          strokeWidth={isAxis ? 1.5 : 1}
        />
      );
    }
    return <g>{lines}</g>;
  };

  const renderPointMarkersAndLabels = (allowInteractive: boolean) =>
    figure.points.map((p) => {
      const px = sx(p.x);
      const py = sy(p.y);
      const away = unitVec(centroidMath, p);
      const off = labelOffsetFromPos(p.labelPos, away, 15);
      const labelText = p.label ? formatFigureLabel(p.label) : '';
      const isPtSelected = allowInteractive && selectedPointId === p.id;
      const pointModeActive = allowInteractive && editMode === 'point';

      return (
        <g key={`pt-${p.id}`}>
          {p.dot && !allowInteractive && (
            <circle cx={px} cy={py} r={4} fill="#3C3C3C" stroke="#FFFFFF" strokeWidth={1.6} />
          )}
          {labelText && (
            <HaloText
              x={px + off.x}
              y={py + off.y}
              textAnchor="middle"
              fill={isPtSelected ? '#7C3AED' : '#3C3C3C'}
              fontSize={13.5}
              style={{ pointerEvents: 'none' }}
            >
              {labelText}
            </HaloText>
          )}
          {allowInteractive && (
            <g
              style={{ cursor: 'move' }}
              onPointerDown={(e) => startPointDrag(e, p)}
            >
              {/* Generous invisible hit circle for touchscreens and mouse */}
              <circle cx={px} cy={py} r={13} fill="transparent" />
              {isPtSelected && (
                <circle
                  cx={px}
                  cy={py}
                  r={10}
                  fill="#A560E8"
                  fillOpacity={0.22}
                  pointerEvents="none"
                />
              )}
              <circle
                cx={px}
                cy={py}
                r={isPtSelected ? 6.5 : pointModeActive ? 5.5 : p.dot ? 4.5 : 4}
                fill={isPtSelected ? '#A560E8' : pointModeActive ? '#1CB0F6' : p.dot ? '#3C3C3C' : '#A560E8'}
                fillOpacity={isPtSelected || pointModeActive || p.dot ? 1 : 0.72}
                stroke="#FFFFFF"
                strokeWidth={1.8}
              />
            </g>
          )}
        </g>
      );
    });

  // Render shapes (polygons, circles, arcs) strictly in user's layer order so shapes inside shapes stack cleanly,
  // followed by segments, angles, then labels and interactive handles on top.
  const sortedElements = useMemo(() => {
    const order = { polygon: 0, circle: 0, arc: 0, segment: 1, angle: 2, label: 3 };
    return figure.elements
      .map((el, idx) => ({ el, idx }))
      .sort((a, b) => order[a.el.type] - order[b.el.type] || a.idx - b.idx);
  }, [figure.elements]);

  const renderSvg = (allowInteractive: boolean) => (
    <svg
      ref={allowInteractive ? svgRef : undefined}
      viewBox={`0 0 ${W} ${H}`}
      className={`w-full h-auto block ${allowInteractive ? 'touch-none select-none' : ''}`}
      role="img"
      aria-label={figure.title || 'شكل هندسي'}
      onPointerMove={allowInteractive ? handleSvgPointerMove : undefined}
      onPointerUp={allowInteractive ? endDrag : undefined}
      onPointerCancel={allowInteractive ? endDrag : undefined}
    >
      {renderGridLines()}
      {sortedElements.map(({ el, idx }) => renderElement(el, idx, allowInteractive))}
      {renderPointMarkersAndLabels(allowInteractive)}
    </svg>
  );

  return (
    <>
      <div
        className={`rounded-2xl border-2 border-[#E5E5E5] bg-white ${
          compact ? 'p-2' : 'p-3'
        } shadow-xs ${className}`}
      >
        {(figure.title || allowZoom) && (
          <div className="flex items-center justify-between gap-2 mb-1.5">
            {figure.title ? (
              <p className="text-xs sm:text-sm font-black text-[#3C3C3C] flex-1 text-center">
                {figure.title}
              </p>
            ) : (
              <span />
            )}
            {allowZoom && (
              <button
                type="button"
                onClick={() => setZoomed(true)}
                className="w-7 h-7 rounded-xl border-2 border-[#E5E5E5] hover:border-[#1CB0F6] text-[#777777] hover:text-[#1899D6] flex items-center justify-center bg-white shrink-0 cursor-pointer transition-colors"
                title="تكبير الشكل الهندسي"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
        <div dir="ltr" className="rounded-xl bg-[#FAFAFA] border border-[#F0F0F0] overflow-hidden">
          {renderSvg(interactive && !zoomed)}
        </div>
        {figure.caption && (
          <p className="mt-2 text-xs font-extrabold text-[#777777] text-center">
            {figure.caption}
          </p>
        )}
      </div>

      {zoomed && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setZoomed(false)}
        >
          <div
            className="duo-card bg-white w-full max-w-2xl p-4 sm:p-5 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-base font-black text-[#3C3C3C]">
                {figure.title || 'عرض الشكل الهندسي'}
              </h4>
              <button
                type="button"
                onClick={() => setZoomed(false)}
                className="duo-btn duo-btn-ghost w-9 h-9 p-0"
                title="إغلاق"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div dir="ltr" className="rounded-2xl border-2 border-[#E5E5E5] bg-[#FAFAFA] p-2">
              {renderSvg(false)}
            </div>
            {figure.caption && (
              <p className="text-sm font-extrabold text-[#777777] text-center">
                {figure.caption}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
};

