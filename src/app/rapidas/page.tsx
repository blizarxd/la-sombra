import { getDb } from "@/db/client";
import { CATEGORY_LABELS, type CategoryKey } from "@/lib/category";
import { CAPITAL_START, FAST_RESOLVE_HOURS, FLAT_STAKE, MAX_CONCURRENT } from "@/lib/fastBook";
import { money, when } from "@/lib/format";
import { getFastBook } from "@/lib/queries";
import { Card, PnlText, Stat, Table, Td, Th } from "../components/ui";

export const dynamic = "force-dynamic";

const SKIP_LABEL: Record<string, string> = {
  concurrencia: "el libro estaba lleno",
  capital: "no quedaba efectivo",
  "libro-fino": `el libro no absorbía $${FLAT_STAKE}`,
  duplicada: "ya teníamos esa misma apuesta",
};

const EXIT_LABEL: Record<string, string> = {
  resolucion: "esperó al oráculo",
  "salida-brazo": "la billetera vendió",
  "venta-anticipada": "vendida ya decidida",
};

const STATUS_LABEL: Record<string, { text: string; className: string }> = {
  open: { text: "⏳ abierta", className: "text-mist" },
  resolved: { text: "✅ resuelta", className: "text-bright" },
  closed: { text: "🔁 cerrada", className: "text-bright" },
  skipped: { text: "⊘ saltada", className: "text-mist" },
};

function pct(n: number | null, digits = 1) {
  return n === null ? "—" : `${(n * 100).toFixed(digits)}%`;
}

export default function RapidasPage() {
  const db = getDb();
  const b = getFastBook(db);
  const growth = (b.capital - CAPITAL_START) / CAPITAL_START;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-bright">⚡ Rápidas — forward-test del hallazgo de duración</h1>
        <p className="mt-2 max-w-3xl text-sm text-mist">
          En /matriz, los mercados <strong>programados para resolver en menos de 1 hora</strong> fueron la celda más
          fuerte del tablero: +$473,78 en total, mientras que 1-6h dio −$1.275,60. Por categoría, Esports en ese hueco
          rindió <strong className="text-bright">+17,9%</strong> (n=401) y Deportes <strong className="text-bright">+8,4%</strong>{" "}
          (n=359). Cripto solo dio +0,5% — demasiado débil para confiar, así que se excluye aquí.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-mist">
          Esta página sigue esa señal hacia adelante, igual que{" "}
          <a href="/capital" className="text-accent underline">
            /capital
          </a>{" "}
          hace con la banda de precio: un banco simulado de ${CAPITAL_START}, ${FLAT_STAKE} plano, una apuesta por
          mercado, precio de entrada medido para el tamaño real. La selección usa la duración{" "}
          <strong>esperada al momento de copiar</strong> (fecha de cierre programada del mercado menos ahora) — nunca
          cuánto tardó de verdad en resolver, que solo se sabe después y no serviría para elegir nada.
        </p>
        <p className="mt-2 max-w-3xl text-xs text-mist">
          Elegibilidad: Esports + Deportes, duración esperada ≤ {FAST_RESOLVE_HOURS}h, todos los brazos menos La Crema.
          Solo papel — aquí no se envía ninguna orden.
        </p>
      </div>

      {b.broken ? (
        <Card title="⚠️ El libro no está registrando">
          <p className="text-sm text-loss">
            La consulta falló, así que esta página no puede decir nada. No es que no haya operaciones todavía — es que
            no se están leyendo.
          </p>
          <pre className="mt-2 overflow-x-auto rounded border border-edge bg-panel2 p-2 text-xs text-mist">
            {b.broken}
          </pre>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Capital actual"
          value={money(b.capital)}
          tone={b.capital > CAPITAL_START ? "profit" : b.capital < CAPITAL_START ? "loss" : "neutral"}
          hint={`empezó en ${money(CAPITAL_START)} · ${growth >= 0 ? "+" : ""}${(growth * 100).toFixed(1)}%`}
        />
        <Stat
          label="Liquidadas"
          value={String(b.settledCount)}
          hint={b.winRate !== null ? `${pct(b.winRate, 0)} de acierto` : "aún ninguna"}
        />
        <Stat
          label="ROI por apuesta"
          value={b.roi === null ? "—" : pct(b.roi, 1)}
          tone={b.roi === null ? "neutral" : b.roi > 0 ? "profit" : "loss"}
          hint="esperábamos ~+17,9% (esports) / +8,4% (deportes)"
        />
        <Stat
          label="Abiertas ahora"
          value={`${b.open.length} / ${MAX_CONCURRENT}`}
          hint={`${money(b.committed)} comprometidos`}
        />
      </div>

      <Card title="🚪 ¿Rota los cupos igual que la banda?">
        <p className="mb-3 text-sm text-mist">
          Esta es la razón práctica para probar esto: si las posiciones cierran en menos de una hora, el mismo tope de
          cupos que en /capital rechazaba 3 de cada 4 señales debería casi no morder aquí. Si igual se satura, el
          problema no era la banda — es que llegan más señales de las que $500 pueden sostener, sea cual sea la regla.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Señales vistas" value={String(b.seenCount)} />
          <Stat label="Tomadas" value={String(b.takenCount)} tone="profit" />
          <Stat
            label="Saltadas"
            value={String(b.skippedCount)}
            tone={b.skippedCount > b.takenCount ? "watch" : "neutral"}
            hint={b.seenCount ? `${((b.skippedCount / b.seenCount) * 100).toFixed(0)}% de las señales` : undefined}
          />
        </div>
        {b.skipReasons.length ? (
          <ul className="mt-4 space-y-1 text-sm text-mist">
            {b.skipReasons.map(([reason, n]) => (
              <li key={reason}>
                <span className="text-bright">{n}</span> — {SKIP_LABEL[reason] ?? reason}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      {b.exitReasons.length ? (
        <Card title="Cómo terminaron">
          <ul className="space-y-1 text-sm text-mist">
            {b.exitReasons.map(([reason, n]) => (
              <li key={reason}>
                <span className="text-bright">{n}</span> — {EXIT_LABEL[reason] ?? reason}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {b.byCategory.length ? (
        <Card title="Por categoría">
          <Table>
            <thead>
              <tr>
                <Th>Categoría</Th>
                <Th>n</Th>
                <Th>Acierto</Th>
                <Th>ROI</Th>
              </tr>
            </thead>
            <tbody>
              {b.byCategory.map((c) => (
                <tr key={c.category}>
                  <Td>{CATEGORY_LABELS[c.category as CategoryKey] ?? c.category}</Td>
                  <Td className="text-mist">{c.n}</Td>
                  <Td className="text-mist">{pct(c.winRate, 0)}</Td>
                  <Td className={c.roi === null ? "text-mist" : c.roi > 0 ? "text-profit" : "text-loss"}>
                    {pct(c.roi, 1)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}

      <Card title="🔗 ¿Sirve de algo que dos brazos coincidan?">
        <div className="grid gap-4 sm:grid-cols-2">
          <Stat
            label="Con confluencia (2+ brazos)"
            value={b.confluence.count ? pct(b.confluence.roi, 1) : "—"}
            tone={b.confluence.roi === null ? "neutral" : b.confluence.roi > 0 ? "profit" : "loss"}
            hint={`${b.confluence.count} liquidadas`}
          />
          <Stat
            label="De un solo brazo"
            value={b.confluence.soloCount ? pct(b.confluence.soloRoi, 1) : "—"}
            tone={b.confluence.soloRoi === null ? "neutral" : b.confluence.soloRoi > 0 ? "profit" : "loss"}
            hint={`${b.confluence.soloCount} liquidadas`}
          />
        </div>
      </Card>

      <Card title="Movimientos">
        {b.rows.length === 0 ? (
          <p className="text-sm text-mist">
            Todavía sin movimientos. Este libro solo empezó a existir cuando se capturó la duración esperada en cada
            copia nueva, así que arranca vacío.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Abierta</Th>
                <Th>Mercado</Th>
                <Th>Duración esp.</Th>
                <Th>Brazo</Th>
                <Th>Nuestra entrada</Th>
                <Th>Estado</Th>
                <Th>PnL</Th>
                <Th>Capital</Th>
              </tr>
            </thead>
            <tbody>
              {b.rows.slice(0, 100).map((r) => {
                const st = STATUS_LABEL[r.status] ?? { text: r.status, className: "text-mist" };
                return (
                  <tr key={r.id} className={r.status === "skipped" ? "opacity-60" : ""}>
                    <Td className="whitespace-nowrap text-mist">{when(r.openedAt)}</Td>
                    <Td>
                      <div className="max-w-md truncate text-bright">{r.marketQuestion ?? r.marketId}</div>
                      <div className="text-xs text-mist">
                        {r.outcome ?? ""}
                        {r.armConfluence > 1 ? <span className="ml-1 text-accent">🔗 {r.armConfluence} brazos</span> : null}
                        {r.status === "skipped" && r.skipReason ? ` · ${SKIP_LABEL[r.skipReason] ?? r.skipReason}` : ""}
                        {r.exitReason ? ` · ${EXIT_LABEL[r.exitReason] ?? r.exitReason}` : ""}
                      </div>
                    </Td>
                    <Td className="text-mist">
                      {r.expectedResolutionHours === null ? "—" : `${(r.expectedResolutionHours * 60).toFixed(0)} min`}
                    </Td>
                    <Td className="text-mist">{r.sourceTrack}</Td>
                    <Td>
                      {r.entryPrice === null ? (
                        <span className="text-mist">—</span>
                      ) : (
                        <>
                          {(r.entryPrice * 100).toFixed(1)}¢
                          {r.slippageCents ? (
                            <span className="ml-1 text-xs text-watch">+{r.slippageCents.toFixed(2)}¢</span>
                          ) : null}
                        </>
                      )}
                    </Td>
                    <Td className={st.className}>{st.text}</Td>
                    <Td>{r.realizedPnl === null ? <span className="text-mist">—</span> : <PnlText value={r.realizedPnl} />}</Td>
                    <Td className="text-mist">{r.capitalAfter === null ? "—" : money(r.capitalAfter)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Límites honestos de este libro">
        <ul className="space-y-2 text-sm text-mist">
          <li>
            <strong className="text-bright">La duración esperada no es garantía.</strong> Un partido "Map 1 Winner"
            programado en 40 minutos puede irse a penales, retrasarse o entrar en pausa técnica. El libro elige por lo
            que se sabía AL ENTRAR, no por lo que pasó después.
          </li>
          <li>
            <strong className="text-bright">Empieza hoy, en cero.</strong> No hay atajo retroactivo honesto aquí: la
            duración esperada solo se guarda desde que se desplegó esta página.
          </li>
          <li>
            <strong className="text-bright">La salida no está medida.</strong> Igual que en /capital, la entrada se
            cobra al precio real medido; la salida usa el precio que consiguió el brazo con su tamaño chico.
          </li>
          <li>
            <strong className="text-bright">Una orden real movería el precio.</strong> Medimos el libro en el instante
            de copiar, sin contar el efecto de una orden de ${FLAT_STAKE} de verdad.
          </li>
        </ul>
        {b.startedAt ? <p className="mt-3 text-xs text-mist">Registrando desde {when(b.startedAt)}.</p> : null}
      </Card>
    </div>
  );
}
