import { getDb } from "@/db/client";
import { CATEGORY_LABELS } from "@/lib/category";
import type { DepthReport } from "@/lib/depth";
import { when } from "@/lib/format";
import { getDepthStudy } from "@/lib/queries";
import { Card, Stat, Table, Td, Th } from "../components/ui";

export const dynamic = "force-dynamic";

/** The stake the book actually copies at — the baseline every rung compares to. */
const BASE_SIZE = 5;
/** The stake the capital simulation assumed, i.e. the one we need to validate. */
const TARGET_SIZE = 60;

function pct(n: number | null, digits = 1) {
  return n === null ? "—" : `${n.toFixed(digits)}%`;
}
function cents(n: number | null) {
  return n === null ? "—" : `${n.toFixed(2)}¢`;
}

/**
 * A rung is "safe" when the book nearly always absorbs it AND the typical
 * slippage stays small next to the edge being harvested. Both must hold: a
 * cheap fill you only get half the time is not a tradeable size.
 */
function tone(r: { fillRate: number; medianCostPct: number | null }) {
  if (r.fillRate < 0.9) return "loss";
  if (r.medianCostPct !== null && r.medianCostPct > 4) return "loss";
  if (r.medianCostPct !== null && r.medianCostPct > 2) return "watch";
  return "profit";
}

function RungTable({ report }: { report: DepthReport }) {
  if (!report.sampleSize) {
    return (
      <p className="text-sm text-mist">
        Sin datos todavía. La escalera se captura al abrir cada copia nueva; las copias antiguas no la tienen.
      </p>
    );
  }
  return (
    <Table>
      <thead>
        <tr>
          <Th>Tamaño</Th>
          <Th>¿Se llena?</Th>
          <Th>Deslizamiento típico</Th>
          <Th>Peor caso (p90)</Th>
          <Th>Coste sobre la posición</Th>
        </tr>
      </thead>
      <tbody>
        {report.rungs.map((r) => {
          const t = tone(r);
          const cls = t === "loss" ? "text-loss" : t === "watch" ? "text-watch" : "text-profit";
          return (
            <tr key={r.usd}>
              <Td>
                <span className={r.usd === TARGET_SIZE ? "font-semibold text-bright" : ""}>${r.usd}</span>
                {r.usd === BASE_SIZE ? <span className="ml-2 text-xs text-mist">(el que operamos)</span> : null}
                {r.usd === TARGET_SIZE ? <span className="ml-2 text-xs text-accent">(el de la simulación)</span> : null}
              </Td>
              <Td>
                <span className={cls}>{pct(r.fillRate * 100, 0)}</span>
                <span className="ml-1 text-xs text-mist">
                  ({r.fillable}/{r.total})
                </span>
              </Td>
              <Td>{cents(r.medianSlippageCents)}</Td>
              <Td className="text-mist">{cents(r.p90SlippageCents)}</Td>
              <Td>
                <span className={cls}>{pct(r.medianCostPct, 2)}</span>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

export default function ProfundidadPage() {
  const db = getDb();
  const study = getDepthStudy(db);
  const sweet60 = study.sweetBand.rungs.find((r) => r.usd === TARGET_SIZE) ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-bright">📏 Profundidad — ¿cuánto aguanta el libro?</h1>
        <p className="mt-2 max-w-3xl text-sm text-mist">
          Todos los resultados del proyecto se miden copiando <strong>${BASE_SIZE}</strong>. Eso sirve para{" "}
          <em>descubrir</em> una ventaja, pero no dice si aguanta una apuesta de verdad: un libro fino puede llenar $5 al
          mejor precio y cobrarte varios centavos por ${TARGET_SIZE}. Sobre una entrada de ~57¢, 2¢ peores son ~3,5% de la
          posición — se come un cuarto de una ventaja del 14%.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-mist">
          Esta página camina el <strong>mismo libro real</strong> que ya se usa para simular el llenado, a varios tamaños
          hipotéticos. No cuesta ninguna llamada extra a la API y <strong>no cambia nada</strong> de lo que el bot copia
          ni con cuánto. Es medición pura.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Copias con escalera medida"
          value={String(study.overall.sampleSize)}
          hint={study.collectingSince ? `desde ${when(study.collectingSince)}` : "aún sin datos"}
        />
        <Stat
          label={`Se llena a $${TARGET_SIZE} (banda 55-59¢)`}
          value={sweet60 ? pct(sweet60.fillRate * 100, 0) : "—"}
          tone={sweet60 ? (tone(sweet60) as "profit" | "loss" | "watch") : "neutral"}
          hint={sweet60 ? `${sweet60.fillable} de ${sweet60.total} libros` : "recolectando"}
        />
        <Stat
          label={`Coste a $${TARGET_SIZE} (banda 55-59¢)`}
          value={sweet60 ? pct(sweet60.medianCostPct, 2) : "—"}
          tone={sweet60 ? (tone(sweet60) as "profit" | "loss" | "watch") : "neutral"}
          hint="cuánto de la ventaja se come el deslizamiento"
        />
      </div>

      <Card title="⭐ Banda 55-59¢ — la que de verdad importa">
        <p className="mb-3 text-sm text-mist">
          Es la banda que la simulación de capital dio por buena. Si a ${TARGET_SIZE} el llenado aquí se degrada, el
          +700% de esa simulación no es alcanzable, por muy real que sea el histórico a $5.
        </p>
        <RungTable report={study.sweetBand} />
      </Card>

      <Card title="Todas las copias">
        <RungTable report={study.overall} />
      </Card>

      {study.byCategory.length ? (
        <Card title="Por categoría — dónde están los libros finos">
          <p className="mb-3 text-sm text-mist">
            La sospecha a comprobar: los mercados nicho de esports (torneos regionales chicos) tienen libros más finos
            que cripto. Si es así, el tamaño máximo viable no es uno solo — depende de dónde.
          </p>
          <div className="space-y-5">
            {study.byCategory.map(({ category, report }) => {
              const r60 = report.rungs.find((r) => r.usd === TARGET_SIZE);
              return (
                <div key={category}>
                  <h3 className="mb-2 text-sm font-semibold text-bright">
                    {CATEGORY_LABELS[category]}{" "}
                    <span className="font-normal text-mist">
                      — {report.sampleSize} copias
                      {r60 ? ` · $${TARGET_SIZE} se llena ${pct(r60.fillRate * 100, 0)}, coste ${pct(r60.medianCostPct, 2)}` : ""}
                    </span>
                  </h3>
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      <Card title="Cómo leer esto">
        <ul className="space-y-2 text-sm text-mist">
          <li>
            <strong className="text-bright">¿Se llena?</strong> — en qué % de las copias el libro tenía suficiente
            profundidad para absorber ese tamaño. Por debajo de ~90% ese tamaño no es operable: te quedarías fuera de
            demasiadas señales.
          </li>
          <li>
            <strong className="text-bright">Deslizamiento</strong> — cuántos centavos peor sale el precio medio frente
            al mejor precio disponible, por caminar el libro hacia arriba.
          </li>
          <li>
            <strong className="text-bright">Coste sobre la posición</strong> — el mismo deslizamiento como % de lo
            apostado. Este es el número que se resta directo del ROI. Si la ventaja es ~14% y esto marca 4%, te queda
            10%.
          </li>
          <li>
            <strong className="text-bright">Peor caso (p90)</strong> — 1 de cada 10 llenados sale al menos así de malo.
            La mediana sola esconde las colas.
          </li>
        </ul>
        <p className="mt-3 text-xs text-mist">
          Límite honesto: esto mide el libro <em>en el instante de copiar</em>, sin contar que una orden real de ese
          tamaño movería el precio y que otros podrían reaccionar. Es una cota optimista — el coste real sería igual o
          peor, nunca mejor.
        </p>
      </Card>
    </div>
  );
}
