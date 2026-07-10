/** Server-rendered SVG line chart for cumulative paper PnL. No client JS. */
export function PnlChart({
  points,
  height = 180,
}: {
  points: { t: number; pnl: number }[];
  height?: number;
}) {
  if (points.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-mist">
        Aún no hay suficientes capturas de PnL — el gráfico aparece tras unas cuantas actualizaciones por hora.
      </div>
    );
  }
  const width = 720;
  const pad = { l: 44, r: 10, t: 10, b: 22 };
  const xs = points.map((p) => p.t);
  const ys = points.map((p) => p.pnl);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  const spanY = maxY - minY || 1;
  const spanX = maxX - minX || 1;

  const px = (t: number) => pad.l + ((t - minX) / spanX) * (width - pad.l - pad.r);
  const py = (v: number) => pad.t + (1 - (v - minY) / spanY) * (height - pad.t - pad.b);

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.t).toFixed(1)},${py(p.pnl).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const zeroY = py(0);
  const lineColor = last.pnl >= 0 ? "#34d399" : "#fb7185";

  const fmtDay = (t: number) =>
    new Date(t).toLocaleDateString("es-ES", { month: "short", day: "numeric" });

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="PnL en papel a lo largo del tiempo">
      <line x1={pad.l} y1={zeroY} x2={width - pad.r} y2={zeroY} stroke="#232c38" strokeDasharray="4 4" />
      <text x={4} y={py(maxY) + 4} fill="#8b98a9" fontSize="11">
        ${maxY.toFixed(0)}
      </text>
      <text x={4} y={py(minY) + 4} fill="#8b98a9" fontSize="11">
        ${minY.toFixed(0)}
      </text>
      <text x={4} y={zeroY + 4} fill="#8b98a9" fontSize="11">
        $0
      </text>
      <text x={pad.l} y={height - 6} fill="#8b98a9" fontSize="11">
        {fmtDay(minX)}
      </text>
      <text x={width - pad.r} y={height - 6} fill="#8b98a9" fontSize="11" textAnchor="end">
        {fmtDay(maxX)}
      </text>
      <path d={path} fill="none" stroke={lineColor} strokeWidth="2" />
      <circle cx={px(last.t)} cy={py(last.pnl)} r="3.5" fill={lineColor} />
      <text x={Math.min(px(last.t) + 6, width - 40)} y={py(last.pnl) - 6} fill={lineColor} fontSize="12" fontWeight="600">
        ${last.pnl.toFixed(2)}
      </text>
    </svg>
  );
}
