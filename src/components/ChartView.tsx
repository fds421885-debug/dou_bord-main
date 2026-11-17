import React from 'react';
import type { QuizChart } from '../types';
import { CHART_PALETTE, niceScale } from '../quizChart';

const W = 560;
const INK = '#3C3C3C';
const MUTED = '#777777';
const GRID = '#E5E5E5';

function fmt(n: number): string {
  if (Math.abs(n) >= 1e7) return n.toExponential(1);
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(2));
}

function cut(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

const T: React.FC<React.SVGProps<SVGTextElement>> = (props) => (
  <text fontSize={12} fontWeight={700} fill={INK} {...props} />
);

function polar(cx: number, cy: number, r: number, a: number) {
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

export const ChartView: React.FC<{ chart: QuizChart; className?: string }> = ({ chart, className }) => {
  const { type, labels, series } = chart;
  const n = labels.length;
  const S = type === 'pie' ? 1 : series.length;
  const showLegend = type !== 'pie' && series.length > 1;
  const showVals = n * S <= 24;
  const title = chart.title.trim();

  let body: React.ReactNode = null;
  let H = 340;

  if (type === 'pie') {
    const vals = series[0].values.map((v) => Math.max(0, v));
    const total = vals.reduce((a, b) => a + b, 0);
    H = Math.max(300, 90 + n * 24);
    const cx = 170;
    const cy = (H + (title ? 30 : 0)) / 2;
    const r = 105;
    let acc = -Math.PI / 2;
    const slices =
      total <= 0
        ? null
        : vals.map((v, i) => {
            const frac = v / total;
            const a0 = acc;
            const a1 = acc + frac * Math.PI * 2;
            acc = a1;
            if (frac <= 0) return null;
            const color = CHART_PALETTE[i % CHART_PALETTE.length];
            if (frac >= 0.9999) {
              return <circle key={i} cx={cx} cy={cy} r={r} fill={color} stroke="#fff" strokeWidth={2} />;
            }
            const p0 = polar(cx, cy, r, a0);
            const p1 = polar(cx, cy, r, a1);
            const large = a1 - a0 > Math.PI ? 1 : 0;
            return (
              <path
                key={i}
                d={`M ${cx} ${cy} L ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y} Z`}
                fill={color}
                stroke="#fff"
                strokeWidth={2}
              />
            );
          });
    body = (
      <>
        {slices}
        {total <= 0 && <T x={cx} y={cy} textAnchor="middle">لا توجد قيم موجبة</T>}
        {labels.map((l, i) => {
          const y = (title ? 70 : 40) + i * 24;
          const pct = total > 0 ? Math.round((vals[i] / total) * 1000) / 10 : 0;
          return (
            <g key={i}>
              <rect x={310} y={y - 11} width={14} height={14} rx={3} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
              <T x={332} y={y} textAnchor="start">{`${cut(l, 16)}\u200E: ${fmt(series[0].values[i])} \u200E(${pct}%)\u200E`}</T>
            </g>
          );
        })}
      </>
    );
  } else if (type === 'hbar') {
    const m = { t: (title ? 44 : 18) + (showLegend ? 22 : 0), r: 40, b: chart.xLabel ? 58 : 40, l: chart.yLabel ? 124 : 108 };
    const rowH = Math.max(26, Math.min(56, 300 / n));
    const plotH = rowH * n;
    H = m.t + plotH + m.b;
    const plotW = W - m.l - m.r;
    const all = series.flatMap((s) => s.values);
    const sc = niceScale(Math.min(0, ...all), Math.max(0, ...all));
    const x = (v: number) => m.l + (plotW * (v - sc.min)) / (sc.max - sc.min);
    const bh = (rowH * 0.7) / S;
    body = (
      <>
        {sc.ticks.map((tk) => (
          <g key={tk}>
            <line x1={x(tk)} x2={x(tk)} y1={m.t} y2={m.t + plotH} stroke={GRID} />
            <T x={x(tk)} y={m.t + plotH + 16} textAnchor="middle" fontSize={11} fill={MUTED}>{fmt(tk)}</T>
          </g>
        ))}
        <line x1={x(0)} x2={x(0)} y1={m.t} y2={m.t + plotH} stroke={MUTED} strokeWidth={1.5} />
        {labels.map((l, gi) => (
          <g key={gi}>
            <T x={m.l - 8} y={m.t + gi * rowH + rowH / 2 + 4} textAnchor="end">{cut(l, 14)}</T>
            {series.map((s, si) => {
              const v = s.values[gi];
              const x0 = x(0);
              const x1 = x(v);
              const y0 = m.t + gi * rowH + rowH * 0.15 + si * bh;
              return (
                <g key={si}>
                  <rect x={Math.min(x0, x1)} y={y0} width={Math.abs(x1 - x0)} height={bh - 1} rx={3} fill={CHART_PALETTE[si]} />
                  {showVals && (
                    <T x={v >= 0 ? x1 + 4 : x1 - 4} y={y0 + bh / 2 + 4} textAnchor={v >= 0 ? 'start' : 'end'} fontSize={11}>{fmt(v)}</T>
                  )}
                </g>
              );
            })}
          </g>
        ))}
        {chart.xLabel && <T x={m.l + plotW / 2} y={H - 8} textAnchor="middle" fill={MUTED}>{chart.xLabel}</T>}
        {chart.yLabel && <T x={14} y={m.t + plotH / 2} textAnchor="middle" fill={MUTED} transform={`rotate(-90 14 ${m.t + plotH / 2})`}>{chart.yLabel}</T>}
      </>
    );
  } else {
    // bar / line
    const rotate = n > 6 || labels.some((l) => l.length > 9);
    const m = {
      t: (title ? 44 : 18) + (showLegend ? 22 : 0),
      r: 16,
      b: (rotate ? 70 : 40) + (chart.xLabel ? 20 : 0),
      l: chart.yLabel ? 76 : 58,
    };
    const plotW = W - m.l - m.r;
    const plotH = H - m.t - m.b;
    const all = series.flatMap((s) => s.values);
    const sc = niceScale(Math.min(0, ...all), Math.max(0, ...all));
    const y = (v: number) => m.t + plotH * (1 - (v - sc.min) / (sc.max - sc.min));
    const gw = plotW / n;
    const cxOf = (gi: number) => m.l + gw * gi + gw / 2;
    body = (
      <>
        {sc.ticks.map((tk) => (
          <g key={tk}>
            <line x1={m.l} x2={m.l + plotW} y1={y(tk)} y2={y(tk)} stroke={GRID} />
            <T x={m.l - 8} y={y(tk) + 4} textAnchor="end" fontSize={11} fill={MUTED}>{fmt(tk)}</T>
          </g>
        ))}
        <line x1={m.l} x2={m.l + plotW} y1={y(0)} y2={y(0)} stroke={MUTED} strokeWidth={1.5} />
        {type === 'bar' &&
          labels.map((_, gi) =>
            series.map((s, si) => {
              const v = s.values[gi];
              const bw = (gw * 0.7) / S;
              const bx = m.l + gw * gi + gw * 0.15 + si * bw;
              const yy = Math.min(y(v), y(0));
              return (
                <g key={`${gi}-${si}`}>
                  <rect x={bx} y={yy} width={bw - 1} height={Math.abs(y(v) - y(0))} rx={3} fill={CHART_PALETTE[si]} />
                  {showVals && (
                    <T x={bx + bw / 2} y={v >= 0 ? yy - 5 : y(0) + 13} textAnchor="middle" fontSize={11}>{fmt(v)}</T>
                  )}
                </g>
              );
            })
          )}
        {type === 'line' &&
          series.map((s, si) => (
            <g key={si}>
              <polyline
                fill="none"
                stroke={CHART_PALETTE[si]}
                strokeWidth={3}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={s.values.map((v, gi) => `${cxOf(gi)},${y(v)}`).join(' ')}
              />
              {s.values.map((v, gi) => (
                <g key={gi}>
                  <circle cx={cxOf(gi)} cy={y(v)} r={4.5} fill="#fff" stroke={CHART_PALETTE[si]} strokeWidth={3} />
                  {showVals && <T x={cxOf(gi)} y={si % 2 === 0 ? y(v) - 10 : y(v) + 19} textAnchor="middle" fontSize={11}>{fmt(v)}</T>}
                </g>
              ))}
            </g>
          ))}
        {labels.map((l, gi) => {
          const lx = cxOf(gi);
          const ly = m.t + plotH + 16;
          return rotate ? (
            <T key={gi} x={lx} y={ly} textAnchor="end" transform={`rotate(-35 ${lx} ${ly})`} fontSize={11}>{cut(l, 14)}</T>
          ) : (
            <T key={gi} x={lx} y={ly} textAnchor="middle" fontSize={11}>{cut(l, 12)}</T>
          );
        })}
        {chart.xLabel && <T x={m.l + plotW / 2} y={H - 8} textAnchor="middle" fill={MUTED}>{chart.xLabel}</T>}
        {chart.yLabel && <T x={14} y={m.t + plotH / 2} textAnchor="middle" fill={MUTED} transform={`rotate(-90 14 ${m.t + plotH / 2})`}>{chart.yLabel}</T>}
      </>
    );
  }

  return (
    <div className={`rounded-2xl border-2 border-[#E5E5E5] bg-white p-2 ${className ?? ''}`} dir="ltr">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={title || 'رسم بياني'}>
        {title && (
          <T x={W / 2} y={26} textAnchor="middle" fontSize={15} fontWeight={800}>{title}</T>
        )}
        {showLegend &&
          series.map((s, si) => {
            const lx = W / 2 + (si - (series.length - 1) / 2) * 130;
            const ly = title ? 46 : 18;
            return (
              <g key={si}>
                <rect x={lx - 60} y={ly - 10} width={12} height={12} rx={3} fill={CHART_PALETTE[si]} />
                <T x={lx - 43} y={ly} textAnchor="start" fontSize={11}>{cut(s.name || `سلسلة ${si + 1}`, 14)}</T>
              </g>
            );
          })}
        {body}
      </svg>
    </div>
  );
};
