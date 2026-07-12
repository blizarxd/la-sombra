/**
 * Server-rendered SVG line chart for paper PnL. No client JS.
 *
 * Draws two separate series on shared axes:
 *  - realized: settled PnL only (the honest scorecard, steps on resolution/exit)
 *  - marked:   mark-to-market including open positions (noisy, moves every tick)
 *
 * Axes are labeled with price ($, y) and time (day + hour, x).
 */
export function PnlChart({
  marked,
  realized,
  height = 200,
}: {
  marked: { t: number; pnl: number }[];
  realized?: { t: number; pnl: number }[];
  height?: number;
}) {
  const allPoints = [...marked, ...(realized ?? [])];
  if (allPoints.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-mist">
        Aún no hay suficientes capturas de PnL — el gráfico aparece tras unas cuantas actualizaciones por hora.
      </div>
    );
  }
  const width = 720;
  const pad = { l: 48, r: 12, t: 12, b: 34 };
  const xs = allPoints.map((p) => p.t);
  const ys = allPoints.map((p) => p.pnl);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  const spanY = maxY - minY || 1;
  const spanX = maxX - minX || 1;

  const px = (t: number) => pad.l + ((t - minX) / spanX) * (width - pad.l - pad.r);
  const py = (v: number) => pad.t + (1 - (v - minY) / spanY) * (height - pad.t - pad.b);

  const toPath = (pts: { t: number; pnl: number }[]) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.t).toFixed(1)},${py(p.pnl).toFixed(1)}`).join(" ");

  const zeroY = py(0);
  const markedColor = "#64748b"; // slate — the noisy mark-to-market
  const realizedColor = "#34d399"; // emerald — the honest settled line
  const lastMarked = marked[marked.length - 1];
  const lastRealized = realized && realized.length ? realized[realized.length - 1] : null;

  const fmtDay = (t: number) =>
    new Date(t).toLocaleDateString("es-ES", { month: "short", day: "numeric", timeZone: "America/Caracas" });
  const fmtTime = (t: number) =>
    new Date(t).toLocaleString("es-ES", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Caracas",
    });

  // Evenly spaced time ticks (start, middle, end) so the x-axis reads as time.
  const timeTicks = [minX, minX + spanX / 2, maxX];
  // Price gridlines at max / 0 / min.
  const priceTicks = Array.from(new Set([maxY, 0, minY]));

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5" style={{ background: realizedColor }} />
          <span className="text-mist">
            Realizado (liquidado){lastRealized ? `: ` : ""}
            {lastRealized ? (
              <span className="font-semibold" style={{ color: realizedColor }}>
                ${lastRealized.pnl.toFixed(2)}
              </span>
            ) : (
              <span className="text-mist"> sin trades cerrados aún</span>
            )}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5" style={{ background: markedColor, opacity: 0.9 }} />
          <span className="text-mist">
            Valor de mercado (incl. abiertas):{" "}
            <span className="font-semibold" style={{ color: markedColor }}>
              ${lastMarked.pnl.toFixed(2)}
            </span>
          </span>
        </span>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="PnL en papel a lo largo del tiempo">
        {/* price gridlines + labels */}
        {priceTicks.map((v, i) => (
          <g key={`p${i}`}>
            <line
              x1={pad.l}
              y1={py(v)}
              x2={width - pad.r}
              y2={py(v)}
              stroke="#232c38"
              strokeDasharray={v === 0 ? "4 4" : "2 6"}
            />
            <text x={4} y={py(v) + 4} fill="#8b98a9" fontSize="11">
              ${v.toFixed(0)}
            </text>
          </g>
        ))}

        {/* time ticks + labels */}
        {timeTicks.map((t, i) => (
          <text
            key={`t${i}`}
            x={px(t)}
            y={height - 6}
            fill="#8b98a9"
            fontSize="11"
            textAnchor={i === 0 ? "start" : i === timeTicks.length - 1 ? "end" : "middle"}
          >
            {fmtDay(t)}
          </text>
        ))}

        {/* mark-to-market line (noisy) — drawn first, thinner */}
        <path d={toPath(marked)} fill="none" stroke={markedColor} strokeWidth="1.3" opacity="0.75" />

        {/* realized line (honest) — drawn on top, bolder */}
        {realized && realized.length >= 2 ? (
          <path d={toPath(realized)} fill="none" stroke={realizedColor} strokeWidth="2.4" />
        ) : null}

        {/* end markers with price + time */}
        {lastRealized ? (
          <>
            <circle cx={px(lastRealized.t)} cy={py(lastRealized.pnl)} r="3.5" fill={realizedColor} />
            <text
              x={Math.min(px(lastRealized.t) + 6, width - 4)}
              y={py(lastRealized.pnl) - 6}
              fill={realizedColor}
              fontSize="12"
              fontWeight="600"
              textAnchor="end"
            >
              ${lastRealized.pnl.toFixed(2)} · {fmtTime(lastRealized.t)}
            </text>
          </>
        ) : null}
        <circle cx={px(lastMarked.t)} cy={py(lastMarked.pnl)} r="3" fill={markedColor} />
      </svg>
    </div>
  );
}
