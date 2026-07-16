"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CATEGORY_LABELS, categorizeMarket, type CategoryKey } from "@/lib/category";
import { splitComboLegs } from "@/lib/comboLegs";
import { money, price, shortAddr, when } from "@/lib/format";
import { Badge, Empty, PnlText, Table, Td, Th } from "./ui";

/** One trade row, pre-serialized on the server (no functions crossing the boundary). */
export interface TradeRowData {
  id: string;
  openedAtMs: number;
  market: string;
  outcome: string | null;
  side: string;
  walletAddress: string;
  size: number;
  entryPrice: number;
  currentPrice: number | null;
  pnl: number | null;
  status: string;
  reason?: string;
  demo?: boolean;
}

export type TradeColumn =
  | "opened"
  | "market"
  | "wallet"
  | "size"
  | "entry"
  | "current"
  | "pnl"
  | "status"
  | "reason";

const PAGE_SIZES: (number | "all")[] = [10, 20, 50, 100, "all"];

const HEADERS: Record<TradeColumn, { label: string; align?: "right" }> = {
  opened: { label: "Abierto" },
  market: { label: "Mercado" },
  wallet: { label: "Billetera" },
  size: { label: "Tamaño", align: "right" },
  entry: { label: "Entrada", align: "right" },
  current: { label: "Actual", align: "right" },
  pnl: { label: "PnL", align: "right" },
  status: { label: "Estado" },
  reason: { label: "Motivo de entrada" },
};

export function PaginatedTradesTable({
  rows,
  columns,
  emptyHint,
  splitLegs = false,
}: {
  rows: TradeRowData[];
  columns: TradeColumn[];
  emptyHint?: string;
  /** 🧩 Combos only: render the " AND "-joined legs as a numbered list. */
  splitLegs?: boolean;
}) {
  const [pageSize, setPageSize] = useState<number | "all">(20);
  const [page, setPage] = useState(0);
  const [category, setCategory] = useState<CategoryKey | "all">("all");

  // Derive each row's category once (from the market text — the API category is
  // ~98% null). Build the filter options from the categories actually present,
  // with a count, so the dropdown never offers an empty bucket.
  const { rowCat, catCounts } = useMemo(() => {
    const rowCat = new Map<string, CategoryKey>();
    const catCounts = new Map<CategoryKey, number>();
    for (const r of rows) {
      const c = categorizeMarket(r.market);
      rowCat.set(r.id, c);
      catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
    }
    return { rowCat, catCounts };
  }, [rows]);

  const presentCats = [...catCounts.entries()].sort((a, b) => b[1] - a[1]);

  if (rows.length === 0) {
    return <Empty>{emptyHint ?? "Aún no hay trades para mostrar."}</Empty>;
  }

  const filtered = category === "all" ? rows : rows.filter((r) => rowCat.get(r.id) === category);

  const size = pageSize === "all" ? filtered.length : pageSize;
  const totalPages = Math.max(1, Math.ceil(filtered.length / size));
  const clampedPage = Math.min(page, totalPages - 1);
  const start = clampedPage * size;
  const slice = filtered.slice(start, start + size);

  const setSize = (s: number | "all") => {
    setPageSize(s);
    setPage(0);
  };

  const setCat = (c: CategoryKey | "all") => {
    setCategory(c);
    setPage(0);
  };

  const cell = (t: TradeRowData, col: TradeColumn) => {
    switch (col) {
      case "opened":
        return <Td key={col} className="whitespace-nowrap text-mist">{when(t.openedAtMs)}</Td>;
      case "market": {
        // A combo's market text is every leg glued together with " AND " — one
        // unreadable line. Show the legs stacked instead: that IS the pick.
        const legs = splitLegs ? splitComboLegs(t.market) : [];
        return (
          <Td key={col} className="max-w-80">
            {legs.length > 1 ? (
              <ol className="space-y-0.5">
                {legs.map((leg, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="shrink-0 text-[11px] text-mist">{i + 1}.</span>
                    <span>{leg}</span>
                  </li>
                ))}
              </ol>
            ) : (
              t.market
            )}
            {t.demo ? <span className="ml-1 text-[10px] text-fuchsia-300">[DEMO]</span> : null}
            <div className="text-[11px] text-mist">
              {t.outcome ?? ""} · {t.side}
            </div>
          </Td>
        );
      }
      case "wallet":
        return (
          <Td key={col}>
            <Link href={`/wallets/${t.walletAddress}`} className="text-accent hover:underline">
              {shortAddr(t.walletAddress)}
            </Link>
          </Td>
        );
      case "size":
        return <Td key={col} className="text-right">{money(t.size)}</Td>;
      case "entry":
        return <Td key={col} className="text-right">{price(t.entryPrice)}</Td>;
      case "current":
        return <Td key={col} className="text-right">{price(t.currentPrice)}</Td>;
      case "pnl":
        return (
          <Td key={col} className="text-right font-semibold">
            <PnlText value={t.pnl} />
          </Td>
        );
      case "status":
        return (
          <Td key={col}>
            <Badge value={t.status} />
          </Td>
        );
      case "reason":
        return <Td key={col} className="max-w-72 text-xs text-mist">{t.reason ?? "—"}</Td>;
    }
  };

  return (
    <div className="space-y-3">
      {presentCats.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1 text-xs text-mist">
          <span className="mr-1">Categoría:</span>
          <button
            onClick={() => setCat("all")}
            className={`rounded-md border px-2 py-1 ${
              category === "all" ? "border-accent bg-panel2 text-accent" : "border-edge text-mist hover:bg-panel2"
            }`}
          >
            Todas ({rows.length})
          </button>
          {presentCats.map(([c, n]) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`rounded-md border px-2 py-1 ${
                category === c ? "border-accent bg-panel2 text-accent" : "border-edge text-mist hover:bg-panel2"
              }`}
            >
              {CATEGORY_LABELS[c]} ({n})
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-mist">
        <div className="flex items-center gap-1">
          <span className="mr-1">Por página:</span>
          {PAGE_SIZES.map((s) => {
            const active = s === pageSize;
            return (
              <button
                key={String(s)}
                onClick={() => setSize(s)}
                className={`rounded-md border px-2 py-1 ${
                  active
                    ? "border-accent bg-panel2 text-accent"
                    : "border-edge text-mist hover:bg-panel2"
                }`}
              >
                {s === "all" ? "Todos" : s}
              </button>
            );
          })}
        </div>
        <div>
          Mostrando <b className="text-bright">{filtered.length === 0 ? 0 : start + 1}–{Math.min(start + size, filtered.length)}</b> de{" "}
          <b className="text-bright">{filtered.length}</b>
          {category !== "all" ? <span className="ml-1">({CATEGORY_LABELS[category]})</span> : null}
        </div>
      </div>

      <Table>
        <thead>
          <tr>
            {columns.map((c) => (
              <Th key={c} className={HEADERS[c].align === "right" ? "text-right" : ""}>
                {HEADERS[c].label}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slice.map((t) => (
            <tr key={t.id}>{columns.map((c) => cell(t, c))}</tr>
          ))}
        </tbody>
      </Table>

      {totalPages > 1 ? (
        <div className="flex items-center justify-center gap-2 text-xs">
          <button
            onClick={() => setPage(0)}
            disabled={clampedPage === 0}
            className="rounded-md border border-edge px-2 py-1 text-mist enabled:hover:bg-panel2 disabled:opacity-40"
          >
            « Primera
          </button>
          <button
            onClick={() => setPage(clampedPage - 1)}
            disabled={clampedPage === 0}
            className="rounded-md border border-edge px-2 py-1 text-mist enabled:hover:bg-panel2 disabled:opacity-40"
          >
            ‹ Anterior
          </button>
          <span className="px-2 text-mist">
            Página <b className="text-bright">{clampedPage + 1}</b> de {totalPages}
          </span>
          <button
            onClick={() => setPage(clampedPage + 1)}
            disabled={clampedPage >= totalPages - 1}
            className="rounded-md border border-edge px-2 py-1 text-mist enabled:hover:bg-panel2 disabled:opacity-40"
          >
            Siguiente ›
          </button>
          <button
            onClick={() => setPage(totalPages - 1)}
            disabled={clampedPage >= totalPages - 1}
            className="rounded-md border border-edge px-2 py-1 text-mist enabled:hover:bg-panel2 disabled:opacity-40"
          >
            Última »
          </button>
        </div>
      ) : null}
    </div>
  );
}
