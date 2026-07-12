"use client";

import { useMemo, useRef, useState } from "react";

/**
 * Interactive PnL chart (client). Two toggleable series on shared axes:
 *  - realized: settled PnL only (the honest scorecard)
 *  - marked:   mark-to-market including open positions (noisy)
 *
 * Features: click the legend to show/hide a line, animated draw-in, and a
 * hover crosshair that scrubs date + each series' value. No external libs.
 */

type Pt = { t: number; pnl: number };
type SeriesDef = { key: "realized" | "marked"; label: string; color: string; points: Pt[] };

const W = 760;
const PAD = { l: 52, r: 16, t: 16, b: 34 };

/** Min/max bucket downsample: keeps spikes while capping the point count. */
function downsample(points: Pt[], maxPoints = 900): Pt[] {
  if (points.length <= maxPoints) return points;
  const bucketCount = Math.floor(maxPoints / 2);
  const size = points.length / bucketCount;
  const out: Pt[] = [];
  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(b * size);
    const end = Math.min(points.length, Math.floor((b + 1) * size));
    if (end <= start) continue;
    let lo = points[start];
    let hi = points[start];
    for (let i = start; i < end; i++) {
      if (points[i].pnl < lo.pnl) lo = points[i];
      if (points[i].pnl > hi.pnl) hi = points[i];
    }
    // preserve time order within the bucket
    if (lo.t <= hi.t) {
      out.push(lo, hi);
    } else {
      out.push(hi, lo);
    }
  }
  return out;
}

/** Nearest point to time `t` via binary search. */
function nearest(points: Pt[], t: number): Pt | null {
  if (!points.length) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[Math.max(0, lo - 1)];
  return Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b;
}

export function PnlChart({
  marked,
  realized,
  height = 220,
}: {
  marked: Pt[];
  realized?: Pt[];
  height?: number;
}) {
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [hoverX, setHoverX] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const allSeries: SeriesDef[] = useMemo(() => {
    const s: SeriesDef[] = [];
    if (realized && realized.length) s.push({ key: "realized", label: "Realizado (liquidado)", color: "#34d399", points: realized });
    s.push({ key: "marked", label: "Valor de mercado (incl. abiertas)", color: "#94a3b8", points: marked });
    return s;
  }, [marked, realized]);

  const visible = allSeries.filter((s) => !hidden[s.key]);
  const shown = visible.length ? visible : allSeries; // never render totally empty axes

  const allPoints = shown.flatMap((s) => s.points);
  if (allPoints.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-mist">
        Aún no hay suficientes capturas de PnL — el gráfico aparece tras unas cuantas actualizaciones por hora.
      </div>
    );
  }

  const xs = allPoints.map((p) => p.t);
  const ys = allPoints.map((p) => p.pnl);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  const px = (t: number) => PAD.l + ((t - minX) / spanX) * (W - PAD.l - PAD.r);
  const py = (v: number) => PAD.t + (1 - (v - minY) / spanY) * (height - PAD.t - PAD.b);
  const zeroY = py(0);

  const fmtDay = (t: number) =>
    new Date(t).toLocaleDateString("es-ES", { month: "short", day: "numeric", timeZone: "America/Caracas" });
  const fmtFull = (t: number) =>
    new Date(t).toLocaleString("es-ES", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Caracas",
    });

  // Nice-ish price ticks: max, a couple between, 0, min.
  const priceTicks = Array.from(new Set([maxY, maxY / 2, 0, minY / 2, minY].map((v) => Math.round(v))));
  const timeTicks = [minX, minX + spanX / 4, minX + spanX / 2, minX + (3 * spanX) / 4, maxX];

  // Hover: map pixel x back to time, find nearest point on each visible series.
  const hoverT = hoverX != null ? minX + ((hoverX - PAD.l) / (W - PAD.l - PAD.r)) * spanX : null;
  const readouts =
    hoverT != null
      ? shown.map((s) => ({ s, pt: nearest(s.points, hoverT) })).filter((r) => r.pt) as { s: SeriesDef; pt: Pt }[]
      : [];
  const hoverPx = hoverT != null && readouts.length ? px(readouts[0].pt.t) : null;

  const handleMove = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vbX = ((clientX - rect.left) / rect.width) * W;
    if (vbX < PAD.l || vbX > W - PAD.r) {
      setHoverX(null);
      return;
    }
    setHoverX(vbX);
  };

  const tooltipLeftPct = hoverPx != null ? (hoverPx / W) * 100 : 0;
  const tooltipFlip = tooltipLeftPct > 62;

  return (
    <div>
      {/* legend (toggle) */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        {allSeries.map((s) => {
          const off = hidden[s.key];
          const cur = s.points[s.points.length - 1]?.pnl ?? 0;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setHidden((h) => ({ ...h, [s.key]: !h[s.key] }))}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition ${
                off ? "border-edge bg-transparent opacity-45" : "border-edge bg-panel2"
              }`}
              title={off ? "Mostrar esta línea" : "Ocultar esta línea"}
            >
              <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: s.color }} />
              <span className="text-mist">{s.label}</span>
              <span className="font-semibold tabular-nums" style={{ color: off ? "#8b98a9" : s.color }}>
                ${cur.toFixed(2)}
              </span>
              <span className="text-mist">{off ? "＋" : "×"}</span>
            </button>
          );
        })}
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${height}`}
          className="w-full touch-none select-none"
          role="img"
          aria-label="PnL en papel a lo largo del tiempo"
          onMouseMove={(e) => handleMove(e.clientX)}
          onMouseLeave={() => setHoverX(null)}
          onTouchStart={(e) => handleMove(e.touches[0].clientX)}
          onTouchMove={(e) => handleMove(e.touches[0].clientX)}
          onTouchEnd={() => setHoverX(null)}
        >
          <defs>
            {shown.map((s) => (
              <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.28" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {/* price gridlines + labels */}
          {priceTicks.map((v, i) => (
            <g key={`p${i}`}>
              <line
                x1={PAD.l}
                y1={py(v)}
                x2={W - PAD.r}
                y2={py(v)}
                stroke="#232c38"
                strokeWidth={v === 0 ? 1 : 0.75}
                strokeDasharray={v === 0 ? "0" : "2 7"}
              />
              <text x={PAD.l - 8} y={py(v) + 4} fill="#8b98a9" fontSize="11" textAnchor="end" className="tabular-nums">
                ${v}
              </text>
            </g>
          ))}

          {/* time ticks */}
          {timeTicks.map((t, i) => (
            <text
              key={`t${i}`}
              x={px(t)}
              y={height - 8}
              fill="#8b98a9"
              fontSize="11"
              textAnchor={i === 0 ? "start" : i === timeTicks.length - 1 ? "end" : "middle"}
            >
              {fmtDay(t)}
            </text>
          ))}

          {/* series: area + line (marked first so realized sits on top) */}
          {shown
            .slice()
            .sort((a) => (a.key === "realized" ? 1 : -1))
            .map((s) => {
              const ds = downsample(s.points);
              const line = ds.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.t).toFixed(1)},${py(p.pnl).toFixed(1)}`).join(" ");
              const area = `${line} L${px(ds[ds.length - 1].t).toFixed(1)},${zeroY.toFixed(1)} L${px(ds[0].t).toFixed(1)},${zeroY.toFixed(1)} Z`;
              const len = Math.round((W - PAD.l - PAD.r) * 1.8);
              const emphasize = s.key === "realized";
              return (
                <g key={s.key}>
                  <path className="pnl-area" d={area} fill={`url(#grad-${s.key})`} />
                  <path
                    className="pnl-line"
                    d={line}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={emphasize ? 2.4 : 1.4}
                    strokeOpacity={emphasize ? 1 : 0.85}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    style={{ ["--pnl-len" as string]: String(len) }}
                  />
                </g>
              );
            })}

          {/* hover crosshair + dots */}
          {hoverPx != null ? (
            <g>
              <line x1={hoverPx} y1={PAD.t} x2={hoverPx} y2={height - PAD.b} stroke="#4b5563" strokeWidth="1" strokeDasharray="3 3" />
              {readouts.map((r) => (
                <circle key={r.s.key} cx={px(r.pt.t)} cy={py(r.pt.pnl)} r="4" fill={r.s.color} stroke="#11161d" strokeWidth="1.5" />
              ))}
            </g>
          ) : null}
        </svg>

        {/* tooltip */}
        {hoverPx != null && readouts.length ? (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-[9rem] rounded-lg border border-edge bg-panel2/95 p-2 text-xs shadow-lg backdrop-blur"
            style={{
              left: `${tooltipLeftPct}%`,
              transform: tooltipFlip ? "translateX(-100%) translateX(-10px)" : "translateX(10px)",
            }}
          >
            <div className="mb-1 font-semibold text-bright">{fmtFull(readouts[0].pt.t)}</div>
            {readouts.map((r) => (
              <div key={r.s.key} className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 text-mist">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: r.s.color }} />
                  {r.s.key === "realized" ? "Liquidado" : "Mercado"}
                </span>
                <span className="font-semibold tabular-nums" style={{ color: r.pt.pnl >= 0 ? "#34d399" : "#fb7185" }}>
                  {r.pt.pnl >= 0 ? "+" : ""}${r.pt.pnl.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <p className="mt-2 text-[11px] leading-4 text-mist">
        Toca o pasa el cursor para ver la fecha y los valores. Haz clic en la leyenda para mostrar u ocultar cada línea.
      </p>
    </div>
  );
}
