import { getDb } from "@/db/client";
import { getSliceMatrices } from "@/lib/queries";
import { APP_TZ } from "@/lib/format";
import type { Matrix, MatrixCell } from "@/lib/slices";
import { Card, Empty, PnlText, Table, Td, Th } from "../components/ui";

export const dynamic = "force-dynamic";

function Cell({ cell, best, worst, minSample }: { cell: MatrixCell | null; best: boolean; worst: boolean; minSample: number }) {
  if (!cell) return <span className="text-mist">—</span>;
  const thin = cell.count < minSample;
  return (
    <div className={thin ? "opacity-50" : ""}>
      <div className="font-medium">
        <PnlText value={cell.pnl} />
        {best ? <span title="Mejor fila de esta columna"> 🏆</span> : null}
        {worst ? <span title="Peor fila de esta columna"> 🚫</span> : null}
      </div>
      <div className="text-[11px] text-mist">
        {cell.count}
        {thin ? "⚠" : ""} · {(cell.winRate * 100).toFixed(0)}% · ROI {(cell.roi * 100).toFixed(1)}%
      </div>
    </div>
  );
}

function MatrixCard({ m }: { m: Matrix }) {
  if (m.rows.length === 0) {
    return (
      <Card title={m.title}>
        <Empty>Aún no hay trades liquidados suficientes para esta matriz.</Empty>
      </Card>
    );
  }
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold text-white">{m.title}</h2>
        <p className="text-xs text-mist">{m.hint}</p>
      </div>
      <Table>
        <thead>
          <tr>
            <Th></Th>
            {m.cols.map((c) => (
              <Th key={c.key}>{c.label}</Th>
            ))}
            <Th className="text-right">Total</Th>
          </tr>
        </thead>
        <tbody>
          {m.rows.map((row) => (
            <tr key={row.key}>
              <Td className="whitespace-nowrap font-medium text-white">{row.label}</Td>
              {m.cols.map((c) => {
                const best = m.bestPerCol[c.key] === row.key;
                const worst = m.worstPerCol[c.key] === row.key;
                return (
                  <Td key={c.key} className={best ? "bg-emerald-950/30" : worst ? "bg-rose-950/20" : ""}>
                    <Cell cell={row.cells[c.key]} best={best} worst={worst} minSample={m.minSample} />
                  </Td>
                );
              })}
              <Td className="text-right">
                <PnlText value={row.totalPnl} />
                <div className="text-[11px] text-mist">{row.totalCount}</div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="text-[11px] text-mist">
        Cada celda: PnL realizado · nº de copias liquidadas · % de aciertos · ROI (PnL ÷ dinero puesto). 🏆 = mejor fila de
        esa columna, 🚫 = peor, coronadas por ROI y solo con {m.minSample}+ copias liquidadas. Las celdas con menos muestra
        salen en gris con ⚠ — son ruido, no señal.
      </p>
    </section>
  );
}

export default function MatrizPage() {
  const db = getDb();
  const matrices = getSliceMatrices(db);
  const total = matrices[0]?.sampleSize ?? 0;

  return (
    <main className="mx-auto max-w-6xl space-y-8 p-6">
      <header>
        <h1 className="text-xl font-semibold text-white">🔬 Matriz — ¿cuándo y a qué precio nos va mejor?</h1>
        <p className="mt-1 text-sm text-mist">
          Los mismos {total} trades liquidados, cortados por hora, por banda de entrada y por día. Todas las horas son tu
          hora ({APP_TZ}, UTC-4) y usan el momento en que se ABRIÓ la copia.
        </p>
      </header>

      <Card title="Cómo leer esto sin engañarse">
        <ul className="space-y-1.5 text-sm text-mist">
          <li>
            <span className="text-white">Esto NO son reglas.</span> Nada de esta página ajusta el bot solo. Son hipótesis
            para que tú y el cerebro las discutan en el corte de las 8am.
          </li>
          <li>
            <span className="text-white">Cortar los mismos datos de 4 formas siempre produce celdas “calientes” falsas.</span>{" "}
            Con 6 franjas × 5 brazos ya son 30 celdas: alguna se ve genial por pura suerte. Por eso el mínimo de muestra y
            por eso el ROI manda sobre el PnL bruto (los libros apuestan tamaños distintos).
          </li>
          <li>
            <span className="text-white">Una celda solo se gradúa a regla si sobrevive un forward-test.</span> La ves
            aquí, la anotas, esperas 1–2 semanas de datos NUEVOS y compruebas que sigue ahí. Así se hizo en botpolym — y
            así se descubrió que el hallazgo “estrella” de la hora en realidad era la banda de entrada.
          </li>
        </ul>
      </Card>

      {matrices.map((m) => (
        <MatrixCard key={m.id} m={m} />
      ))}
    </main>
  );
}
