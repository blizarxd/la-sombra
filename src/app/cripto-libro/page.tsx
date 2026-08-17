import { getDb } from "@/db/client";
import { CAPITAL_START, EXIT_DOOR_LABELS, FLAT_STAKE, MAX_CONCURRENT, TIME_STOP_HOURS, type ExitDoor } from "@/lib/criptoBook";
import { money, when } from "@/lib/format";
import { getCriptoBook } from "@/lib/queries";
import { Card, PnlText, Stat, Table, Td, Th } from "../components/ui";

export const dynamic = "force-dynamic";

const SKIP_LABEL: Record<string, string> = {
  concurrencia: "el libro estaba lleno",
  capital: "no quedaba efectivo",
  "libro-fino": `el libro no absorbía $${FLAT_STAKE}`,
  duplicada: "ya teníamos esa misma apuesta",
};

const DOOR_TONE: Record<string, string> = {
  "precio-decidido": "text-bright",
  "salida-billetera": "text-profit",
  "tiempo-agotado": "text-watch",
  resolucion: "text-loss",
};

function pct(n: number | null, digits = 1) {
  return n === null ? "—" : `${(n * 100).toFixed(digits)}%`;
}

export default function CriptoLibroPage() {
  const db = getDb();
  const b = getCriptoBook(db);
  const growth = (b.capital - CAPITAL_START) / CAPITAL_START;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-bright">₿ Libro Cripto — el único filtro de entrada con piso positivo</h1>
        <p className="mt-2 max-w-3xl text-sm text-mist">
          Tras un día de forward-test, solo un criterio resultó a la vez rentable y{" "}
          <strong className="text-bright">conocible antes de apostar</strong>: la categoría. En las 100 operaciones
          liquidadas del libro de capital, Cripto rindió <strong className="text-profit">+35,5%</strong> (n=23, 78% de
          acierto, piso 90% <strong className="text-profit">+6,3%</strong>) mientras Esports —3 de cada 4 operaciones—
          quedó en <strong>−0,0%</strong> (n=77, piso −12,2%). Toda la ganancia venía de un cuarto de las apuestas.
        </p>
      </div>

      <Card title="⚠️ Lo que este libro NO afirma">
        <p className="text-sm text-mist">
          Que vender a 97¢ sea la ventaja. Esa celda marcó +53% con 88% de acierto, y casi seguro es{" "}
          <strong className="text-bright">selección, no habilidad</strong>: una posición llega a 97¢{" "}
          <em>porque va ganando</em>, así que &quot;vendida a 97¢&quot; es casi un sinónimo de &quot;acertamos&quot;.
        </p>
        <p className="mt-2 text-sm text-mist">
          Y hay más: si aguantas una ganadora de 97¢ hasta que resuelva, cobras 100¢. Vender ahí es{" "}
          <strong className="text-bright">3¢ PEOR por operación</strong>, no mejor. La regla se mantiene solo por{" "}
          <strong>eficiencia de capital</strong> — liberar el cupo horas antes compra más operaciones, y el cuello de
          botella de este proyecto siempre ha sido el número de operaciones, no el precio.
        </p>
        <p className="mt-2 text-sm text-mist">
          Leer &quot;97¢ = ganancia&quot; sería repetir la trampa que infló 4× una simulación anterior.
        </p>
      </Card>

      <Card title="📉 La novedad: la salida también se cobra de verdad">
        <p className="text-sm text-mist">
          Todos los libros anteriores medían con cuidado el precio de <strong>entrada</strong> (caminando el libro de
          órdenes real para $
          {FLAT_STAKE}) pero luego vendían al precio de referencia, como si el mercado absorbiera la posición entera de
          golpe. Este camina también el <strong>lado de venta</strong> con el número real de acciones.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Stat
            label="Deslizamiento al ENTRAR"
            value={b.medianEntrySlippageCents === null ? "—" : `${b.medianEntrySlippageCents.toFixed(2)}¢`}
            hint="mediana, medido en el libro"
          />
          <Stat
            label="Deslizamiento al SALIR"
            value={b.medianExitSlippageCents === null ? "—" : `${b.medianExitSlippageCents.toFixed(2)}¢`}
            hint={`mediana sobre ${b.exitPricedCount} salidas medidas`}
          />
        </div>
        <p className="mt-3 text-xs text-mist">
          Si no hay foto del lado de venta, la posición <strong>no se cierra</strong> — se queda abierta y se reporta.
          Inventar el precio del toque sería exactamente la suposición que este libro existe para eliminar.
        </p>
      </Card>

      {b.broken ? (
        <Card title="⚠️ El libro no está registrando">
          <p className="text-sm text-loss">La consulta falló. No es que no haya operaciones — es que no se leen.</p>
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
          label="Cerradas"
          value={String(b.settledCount)}
          hint={b.winRate !== null ? `${pct(b.winRate, 0)} de acierto` : "aún ninguna"}
        />
        <Stat
          label="ROI por apuesta"
          value={b.roi === null ? "—" : pct(b.roi, 1)}
          tone={b.roi === null ? "neutral" : b.roi > 0 ? "profit" : "loss"}
          hint="el histórico decía +35,5% (piso +6,3%)"
        />
        <Stat
          label="Abiertas ahora"
          value={`${b.open.length} / ${MAX_CONCURRENT}`}
          hint={`${money(b.committed)} comprometidos`}
        />
      </div>

      <Card title="🚪 Por qué puerta salió cada una">
        {b.doors.length === 0 ? (
          <p className="text-sm text-mist">Todavía sin cierres.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Puerta</Th>
                <Th>n</Th>
                <Th>% del total</Th>
                <Th>Acierto</Th>
                <Th>ROI</Th>
                <Th>Horas</Th>
              </tr>
            </thead>
            <tbody>
              {b.doors.map((d) => (
                <tr key={d.door}>
                  <Td className={DOOR_TONE[d.door] ?? "text-mist"}>
                    {EXIT_DOOR_LABELS[d.door as ExitDoor] ?? d.door}
                  </Td>
                  <Td className="text-mist">{d.n}</Td>
                  <Td className="text-mist">{pct(d.share, 0)}</Td>
                  <Td className="text-mist">{pct(d.winRate, 0)}</Td>
                  <Td className={d.roi === null ? "text-mist" : d.roi > 0 ? "text-profit" : "text-loss"}>
                    {pct(d.roi, 1)}
                  </Td>
                  <Td className="text-mist">{d.avgHeldHours === null ? "—" : `${d.avgHeldHours.toFixed(1)}h`}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="🚪 El embudo de entrada">
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Señales vistas" value={String(b.seenCount)} hint="copias en mercados cripto" />
          <Stat label="Tomadas" value={String(b.takenCount)} tone="profit" />
          <Stat label="Saltadas" value={String(b.skippedCount)} />
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

      <Card title="Historial completo">
        {b.rows.length === 0 ? (
          <p className="text-sm text-mist">
            Todavía sin movimientos. Arranca vacío y solo cuenta señales de aquí en adelante — el hallazgo se encontró
            en los datos anteriores, así que contarlos sería hacer trampa.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Abierta</Th>
                <Th>Mercado</Th>
                <Th>Brazo</Th>
                <Th>Entrada</Th>
                <Th>Salida</Th>
                <Th>Puerta</Th>
                <Th>PnL</Th>
                <Th>Capital</Th>
              </tr>
            </thead>
            <tbody>
              {b.rows.slice(0, 200).map((r) => (
                <tr key={r.id} className={r.status === "skipped" ? "opacity-60" : ""}>
                  <Td className="whitespace-nowrap text-mist">{when(r.openedAt)}</Td>
                  <Td>
                    <div className="max-w-md truncate text-bright">{r.marketQuestion ?? r.marketId}</div>
                    <div className="text-xs text-mist">
                      {r.outcome ?? ""}
                      {r.status === "skipped" && r.skipReason
                        ? ` · ${SKIP_LABEL[r.skipReason] ?? r.skipReason}`
                        : ""}
                    </div>
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
                  <Td>
                    {r.exitPrice === null ? (
                      <span className="text-mist">{r.status === "open" ? "abierta" : "—"}</span>
                    ) : (
                      <>
                        {(r.exitPrice * 100).toFixed(1)}¢
                        {r.exitSlippageCents ? (
                          <span className="ml-1 text-xs text-watch">−{r.exitSlippageCents.toFixed(2)}¢</span>
                        ) : null}
                      </>
                    )}
                  </Td>
                  <Td className={r.exitReason ? (DOOR_TONE[r.exitReason] ?? "text-mist") : "text-mist"}>
                    {r.exitReason ? (EXIT_DOOR_LABELS[r.exitReason as ExitDoor] ?? r.exitReason) : "—"}
                  </Td>
                  <Td>{r.realizedPnl === null ? <span className="text-mist">—</span> : <PnlText value={r.realizedPnl} />}</Td>
                  <Td className="text-mist">{r.capitalAfter === null ? "—" : money(r.capitalAfter)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Lo que sigue sin estar modelado">
        <ul className="space-y-2 text-sm text-mist">
          <li>
            <strong className="text-bright">Nuestra propia orden movería el precio.</strong> Medimos el libro tal como
            está; una orden real de ${FLAT_STAKE} lo empujaría en contra, al entrar y al salir.
          </li>
          <li>
            <strong className="text-bright">La foto del lado de venta no es del instante exacto.</strong> Se refresca en
            cada ciclo de marcado, así que puede tener minutos. Entre medias el libro pudo cambiar.
          </li>
          <li>
            <strong className="text-bright">n=23 es una muestra minúscula.</strong> El +35,5% de Cripto viene de 23
            operaciones. Este libro existe justamente para ver si aguanta con más.
          </li>
          <li>
            <strong className="text-bright">Corte por tiempo a las {TIME_STOP_HOURS}h.</strong> Es un número elegido, no
            optimizado. En el libro de Salidas esa puerta rindió −21,8%.
          </li>
        </ul>
        {b.startedAt ? <p className="mt-3 text-xs text-mist">Registrando desde {when(b.startedAt)}.</p> : null}
      </Card>
    </div>
  );
}
