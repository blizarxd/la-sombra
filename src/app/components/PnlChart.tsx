"use client";

import { useMemo, useRef, useState } from "react";

/**
 * PnL over time. Rebuilt from scratch 2026-07-16 — the old one drew noise.
 *
 * WHAT WAS BROKEN: it "downsampled" by emitting the MIN and the MAX of every
 * bucket, which is a waveform technique — it deliberately draws a zigzag
 * between each bucket's floor and ceiling. With ~900 emitted points across
 * ~690px of plot, both series rendered as a hairball. No amount of colour or
 * stroke tuning fixes a chart that is drawing a noise band; the fix is
 * resolution, so the line now carries ONE honest value per time bucket (the
 * last observation in it — a real reading, never an average or an invention).
 *
 * COLOUR CARRIES POLARITY, NOT IDENTITY. PnL around zero is a diverging
 * quantity, so the line and its fill switch hue at the zero line: green above,
 * red below, via a hard gradient stop pinned to y=0 in user space. The old
 * chart painted the realized line green while it sat at -$114, which read as
 * "good" at a glance and was the most misleading thing on the page. Sign is
 * ALSO encoded by position (above/below the zero rule), so the green/red pair
 * — worst adjacent ΔE 9.2 under deuteranopia, inside the 8-12 floor band — is
 * legal here: colour is redundant with position, never the sole channel.
 *
 * The marked series (mark-to-market, moves on every tick) stays a thin muted
 * gray with no fill: it is context, not the scorecard, and must not compete.
 */

type Pt = { t: number; pnl: number };
type SeriesKey = "realized" | "marked";

const W = 760;
const PAD = { l: 54, r: 18, t: 14, b: 32 };

// Diverging poles (profit/loss) + the recessive series.
const POS = "#34d399";
const NEG = "#fb7185";
const MUTED = "#8b98a9";
const SURFACE = "#11161d"; // panel colour: the ring that separates overlapping marks

/**
 * One point per time bucket, carrying the bucket's LAST reading (its "close").
 * Buckets are uniform in TIME, so the x axis stays honest when readings are
 * unevenly spaced. Target ~5px between points: dense enough to keep the shape,
 * sparse enough to read as a line instead of a smear.
 */
export function bucketByTime(points: Pt[], maxPoints: number): Pt[] {
  if (points.length <= maxPoints) return points;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const minT = sorted[0].t;
  const span = sorted[sorted.length - 1].t - minT || 1;
  const size = span / maxPoints;
  const out: Pt[] = [];
  let cur = -1;
  for (const p of sorted) {
    // Clamp: the newest reading lands exactly on the upper edge, which would
    // otherwise open a bucket of its own and emit one point too many.
    const b = Math.min(maxPoints - 1, Math.floor((p.t - minT) / size));
    if (b !== cur) {
      out.push(p);
      cur = b;
    } else {
      out[out.length - 1] = p; // later reading in the same bucket wins
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

/** "1-2-5" rounding: the nearest clean step at or above `raw`. */
export function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/** Gridline ticks on one clean step shared across zero, so 0 always lands on a line. */
export function moneyTicks(minY: number, maxY: number, targetPerSide = 3): number[] {
  const step = niceStep(Math.max(maxY, -minY, 1) / Math.max(targetPerSide, 1));
  const ticks = new Set<number>([0]);
  for (let v = step; v <= maxY + step * 0.001; v += step) ticks.add(Math.round(v));
  for (let v = -step; v >= minY - step * 0.001; v -= step) ticks.add(Math.round(v));
  return [...ticks].sort((a, b) => a - b);
}

/** "-$14" not "$-14" — the sign reads before the currency symbol. */
export function fmtAxisMoney(v: number): string {
  const r = Math.round(v);
  return r < 0 ? `-$${Math.abs(r)}` : `$${r}`;
}

const fmtSigned = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;

export function PnlChart({
  marked,
  realized,
  height = 248,
}: {
  marked: Pt[];
  realized?: Pt[];
  height?: number;
}) {
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [hoverX, setHoverX] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const plotW = W - PAD.l - PAD.r;
  const maxPoints = Math.round(plotW / 5); // ~5px between readings

  const series = useMemo(() => {
    const out: { key: SeriesKey; label: string; points: Pt[] }[] = [];
    if (realized?.length) out.push({ key: "realized", label: "Realizado (liquidado)", points: bucketByTime(realized, maxPoints) });
    if (marked?.length) out.push({ key: "marked", label: "Valor de mercado (incl. abiertas)", points: bucketByTime(marked, maxPoints) });
    return out;
  }, [marked, realized, maxPoints]);

  const visible = series.filter((s) => !hidden[s.key]);
  const shown = visible.length ? visible : series; // never render empty axes

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

  const px = (t: number) => PAD.l + ((t - minX) / spanX) * plotW;
  const py = (v: number) => PAD.t + (1 - (v - minY) / spanY) * (height - PAD.t - PAD.b);
  const zeroY = py(0);
  // Where y=0 sits as a fraction of the plot box — the gradient's hard stop.
  const zeroStop = Math.min(1, Math.max(0, (zeroY - PAD.t) / (height - PAD.t - PAD.b)));

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

  const priceTicks = moneyTicks(minY, maxY);
  const timeTicks = [minX, minX + spanX / 4, minX + spanX / 2, minX + (3 * spanX) / 4, maxX];

  const hoverT = hoverX != null ? minX + ((hoverX - PAD.l) / plotW) * spanX : null;
  const readouts =
    hoverT != null
      ? (shown.map((s) => ({ s, pt: nearest(s.points, hoverT) })).filter((r) => r.pt) as {
          s: { key: SeriesKey; label: string; points: Pt[] };
          pt: Pt;
        }[])
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
      {/* legend: identity swatch + the series' current value in status ink */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        {series.map((s) => {
          const off = hidden[s.key];
          const cur = s.points[s.points.length - 1]?.pnl ?? 0;
          const polarity = cur >= 0 ? POS : NEG;
          // The realized swatch wears its CURRENT polarity (matching where the
          // line ends); marked is always the recessive gray.
          const swatch = off ? "#5b6674" : s.key === "realized" ? polarity : MUTED;
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
              <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: swatch }} />
              <span className="text-mist">{s.label}</span>
              <span className="font-semibold tabular-nums" style={{ color: off ? "#5b6674" : polarity }}>
                {fmtSigned(cur)}
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
            {/* Hard stop at y=0 in USER SPACE: green above the zero rule, red below. */}
            <linearGradient id="pnl-polarity" gradientUnits="userSpaceOnUse" x1="0" y1={PAD.t} x2="0" y2={height - PAD.b}>
              <stop offset={zeroStop} stopColor={POS} />
              <stop offset={zeroStop} stopColor={NEG} />
            </linearGradient>
            {/* Same split, faded — the fill between the line and zero. */}
            <linearGradient id="pnl-polarity-fill" gradientUnits="userSpaceOnUse" x1="0" y1={PAD.t} x2="0" y2={height - PAD.b}>
              <stop offset="0%" stopColor={POS} stopOpacity="0.22" />
              <stop offset={zeroStop} stopColor={POS} stopOpacity="0.04" />
              <stop offset={zeroStop} stopColor={NEG} stopOpacity="0.04" />
              <stop offset="100%" stopColor={NEG} stopOpacity="0.22" />
            </linearGradient>
          </defs>

          {/* gridlines — solid hairlines; the zero rule is one step brighter */}
          {priceTicks.map((v) => (
            <g key={`p${v}`}>
              <line
                x1={PAD.l}
                y1={py(v)}
                x2={W - PAD.r}
                y2={py(v)}
                stroke={v === 0 ? "#3b4756" : "#1c2530"}
                strokeWidth="1"
              />
              <text x={PAD.l - 8} y={py(v) + 4} fill="#8b98a9" fontSize="11" textAnchor="end" className="tabular-nums">
                {fmtAxisMoney(v)}
              </text>
            </g>
          ))}

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

          {/* marked first, so the realized scorecard always sits on top */}
          {shown
            .slice()
            .sort((a) => (a.key === "realized" ? 1 : -1))
            .map((s) => {
              const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.t).toFixed(1)},${py(p.pnl).toFixed(1)}`).join(" ");
              const isRealized = s.key === "realized";
              const area = `${d} L${px(s.points[s.points.length - 1].t).toFixed(1)},${zeroY.toFixed(1)} L${px(s.points[0].t).toFixed(1)},${zeroY.toFixed(1)} Z`;
              const len = Math.round(plotW * 1.8);
              return (
                <g key={s.key}>
                  {isRealized ? <path className="pnl-area" d={area} fill="url(#pnl-polarity-fill)" /> : null}
                  <path
                    className="pnl-line"
                    d={d}
                    fill="none"
                    stroke={isRealized ? "url(#pnl-polarity)" : MUTED}
                    strokeWidth={isRealized ? 2 : 1.5}
                    strokeOpacity={isRealized ? 1 : 0.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    style={{ ["--pnl-len" as string]: String(len) }}
                  />
                </g>
              );
            })}

          {/* end-of-line anchor: the direct label the eye lands on (legend carries its number) */}
          {shown.map((s) => {
            const last = s.points[s.points.length - 1];
            if (!last) return null;
            const isRealized = s.key === "realized";
            return (
              <circle
                key={`end-${s.key}`}
                cx={px(last.t)}
                cy={py(last.pnl)}
                r={isRealized ? 4.5 : 3.5}
                fill={isRealized ? (last.pnl >= 0 ? POS : NEG) : MUTED}
                fillOpacity={isRealized ? 1 : 0.6}
                stroke={SURFACE}
                strokeWidth="2"
              />
            );
          })}

          {/* hover crosshair — solid, recessive (a dashed rule reads as noise) */}
          {hoverPx != null ? (
            <g>
              <line x1={hoverPx} y1={PAD.t} x2={hoverPx} y2={height - PAD.b} stroke="#3b4756" strokeWidth="1" />
              {readouts.map((r) => (
                <circle
                  key={r.s.key}
                  cx={px(r.pt.t)}
                  cy={py(r.pt.pnl)}
                  r="4.5"
                  fill={r.s.key === "realized" ? (r.pt.pnl >= 0 ? POS : NEG) : MUTED}
                  stroke={SURFACE}
                  strokeWidth="2"
                />
              ))}
            </g>
          ) : null}
        </svg>

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
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: r.s.key === "realized" ? (r.pt.pnl >= 0 ? POS : NEG) : MUTED }}
                  />
                  {r.s.key === "realized" ? "Liquidado" : "Mercado"}
                </span>
                <span className="font-semibold tabular-nums" style={{ color: r.pt.pnl >= 0 ? POS : NEG }}>
                  {fmtSigned(r.pt.pnl)}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <p className="mt-2 text-[11px] leading-4 text-mist">
        La línea se pone <span style={{ color: POS }}>verde por encima de $0</span> y{" "}
        <span style={{ color: NEG }}>roja por debajo</span>. Toca o pasa el cursor para ver la fecha y los valores; haz
        clic en la leyenda para mostrar u ocultar cada línea.
      </p>
    </div>
  );
}
