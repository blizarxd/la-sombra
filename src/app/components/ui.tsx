import type { ReactNode } from "react";

export function Card({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-edge bg-panel p-4 ${className}`}>
      {title ? <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-mist">{title}</h2> : null}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: string;
  tone?: "profit" | "loss" | "watch" | "neutral";
  hint?: string;
}) {
  const toneClass =
    tone === "profit" ? "text-profit" : tone === "loss" ? "text-loss" : tone === "watch" ? "text-watch" : "text-bright";
  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <div className="text-xs uppercase tracking-wider text-mist">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-mist">{hint}</div> : null}
    </div>
  );
}

const badgeTones: Record<string, string> = {
  paper_copy: "bg-emerald-950 text-profit border-emerald-800",
  track: "bg-emerald-950 text-profit border-emerald-800",
  won: "bg-emerald-950 text-profit border-emerald-800",
  open: "bg-sky-950 text-accent border-sky-800",
  watchlist: "bg-amber-950 text-watch border-amber-800",
  watch: "bg-amber-950 text-watch border-amber-800",
  pending: "bg-amber-950 text-watch border-amber-800",
  skip: "bg-slate-800 text-mist border-slate-700",
  ignore: "bg-slate-800 text-mist border-slate-700",
  closed: "bg-slate-800 text-mist border-slate-700",
  lost: "bg-rose-950 text-loss border-rose-800",
  resolved: "bg-slate-800 text-bright border-slate-600",
  demo: "bg-fuchsia-950 text-fuchsia-300 border-fuchsia-800",
};

const badgeLabels: Record<string, string> = {
  paper_copy: "copiado",
  track: "seguida",
  won: "ganado",
  open: "abierto",
  watchlist: "vigilancia",
  watch: "vigilar",
  pending: "pendiente",
  skip: "descartado",
  ignore: "ignorada",
  closed: "cerrado",
  lost: "perdido",
  resolved: "resuelto",
  demo: "demo",
};

export function Badge({ value }: { value: string }) {
  const tone = badgeTones[value] ?? "bg-slate-800 text-mist border-slate-700";
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${tone}`}>
      {badgeLabels[value] ?? value.replace("_", " ")}
    </span>
  );
}

export function DemoTag() {
  return <Badge value="demo" />;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-edge p-8 text-center text-sm text-mist">{children}</div>
  );
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return (
    <th className={`px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-mist ${className}`}>
      {children}
    </th>
  );
}

export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top text-sm ${className}`}>{children}</td>;
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-edge bg-panel">
      <table className="w-full border-collapse [&_tbody_tr]:border-t [&_tbody_tr]:border-edge [&_tbody_tr:hover]:bg-panel2">
        {children}
      </table>
    </div>
  );
}

export function PnlText({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-mist">—</span>;
  const cls = value > 0 ? "text-profit" : value < 0 ? "text-loss" : "text-mist";
  return (
    <span className={cls}>
      {value > 0 ? "+" : ""}${value.toFixed(2)}
    </span>
  );
}
