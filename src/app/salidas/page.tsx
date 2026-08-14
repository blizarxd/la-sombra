import { getDb } from "@/db/client";
import { CATEGORY_LABELS, type CategoryKey } from "@/lib/category";
import { CAPITAL_START, EXIT_DOOR_LABELS, FLAT_STAKE, MAX_CONCURRENT, TIME_STOP_HOURS, type ExitDoor } from "@/lib/exitBook";
import { money, when } from "@/lib/format";
import { getExitBook } from "@/lib/queries";
import { Card, PnlText, Stat, Table, Td, Th } from "../components/ui";

export const dynamic = "force-dynamic";

const SKIP_LABEL: Record<string, string> = {
  concurrencia: "el libro estaba lleno",
  capital: "no quedaba efectivo",
  "libro-fino": `el libro no absorbía $${FLAT_STAKE}`,
  duplicada: "ya teníamos esa misma apuesta",
};

const STATUS_LABEL: Record<string, { text: string; className: string }> = {
  open: { text: "⏳ abierta", className: "text-mist" },
  resolved: { text: "⚠️ llegó al oráculo", className: "text-loss" },
  closed: { text: "✅ salida", className: "text-bright" },
  skipped: { text: "⊘ saltada", className: "text-mist" },
};

const DOOR_TONE: Record<string, string> = {
  "salida-billetera": "text-profit",
  "precio-decidido": "text-bright",
  "tiempo-agotado": "text-watch",
  resolucion: "text-loss",
};

function pct(n: number | null, digits = 1) {
  return n === null ? "—" : `${(n * 100).toFixed(digits)}%`;
}

export default function SalidasPage() {
  const db = getDb();
  const b = getExitBook(db);
  const growth = (b.capital - CAPITAL_START) / CAPITAL_START;
  const walletDoor = b.doors.find((d) => d.door === "salida-billetera");
  const oracleDoor = b.doors.find((d) => d.door === "resolucion");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-bright">🚪 Salidas — la estrategia es cómo sales, no qué entras</h1>
        <p className="mt-2 max-w-3xl text-sm text-mist">
          Sobre 10.381 copias liquidadas, el corte más fuerte de todo el historial no fue de entrada sino de salida:
          las posiciones cerradas <strong className="text-bright">siguiendo a la billetera cuando vendió</strong>{" "}
          rindieron <strong className="text-profit">+39,1%</strong> (Esports +43,2%, n=292, 70% de acierto), mientras
          que las que se <strong className="text-bright">aguantaron hasta el oráculo</strong> rindieron{" "}
          <strong className="text-loss">−7,8%</strong>. Mismas señales, mismos brazos — la diferencia entera está en
          cómo terminaron.
        </p>
      </div>

      <Card title="⚠️ Por qué el +39% NO se puede copiar tal cual">
        <p className="text-sm text-mist">
          &quot;Las operaciones donde la billetera vendió&quot; es una población que solo se conoce{" "}
          <strong className="text-bright">después</strong>. Montar un libro que admitiera solo esas sería elegir con
          información del futuro — exactamente el error que infló 4× aquella simulación de capital.
        </p>
        <p className="mt-3 text-sm text-mist">
          Lo que sí es alcanzable es la <strong className="text-bright">disciplina</strong>: entrar como entran los
          brazos y <strong>no esperar nunca al oráculo</strong>. Cada posición sale por una de tres puertas:
        </p>
        <ol className="mt-3 space-y-1 text-sm text-mist">
          <li>
            <strong className="text-profit">1.</strong> La billetera vende → la seguimos (el caso del hallazgo)
          </li>
          <li>
            <strong className="text-bright">2.</strong> El precio deja de estar en duda (≥97¢ o ≤3¢) → vendemos ahí
          </li>
          <li>
            <strong className="text-watch">3.</strong> Ninguna de las dos en {TIME_STOP_HOURS}h → cortamos igual al
            precio de mercado
          </li>
        </ol>
        <p className="mt-3 text-sm text-mist">
          La <strong>mezcla de las tres</strong> es el retorno honesto. La puerta 3 es la que hace que esta medición
          valga: es lo que pasa cuando la billetera nunca vende, y su coste es justo lo que el +39,1% dejaba fuera.
        </p>
      </Card>

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
          label="Cerradas"
          value={String(b.settledCount)}
          hint={b.winRate !== null ? `${pct(b.winRate, 0)} de acierto` : "aún ninguna"}
        />
        <Stat
          label="ROI por apuesta"
          value={b.roi === null ? "—" : pct(b.roi, 1)}
          tone={b.roi === null ? "neutral" : b.roi > 0 ? "profit" : "loss"}
          hint="la mezcla de las tres puertas"
        />
        <Stat
          label="Abiertas ahora"
          value={`${b.open.length} / ${MAX_CONCURRENT}`}
          hint={`${money(b.committed)} comprometidos`}
        />
      </div>

      <Card title="🚪 Por qué puerta salió cada una — el dato que decide todo">
        <p className="mb-3 text-sm text-mist">
          Si la mayoría sale por <strong className="text-profit">la billetera vendió</strong>, la disciplina está
          capturando el hallazgo. Si domina{" "}
          <strong className="text-watch">corte por tiempo</strong>, estamos cortando a ciegas y el resultado dependerá
          de la suerte, no de la señal. Y si aparece <strong className="text-loss">llegó al oráculo</strong>, es que la
          regla falló en sacarnos a tiempo.
        </p>
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
                <Th>Horas retenida</Th>
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
                  <Td className="text-mist">
                    {d.avgHeldHours === null ? "—" : `${d.avgHeldHours.toFixed(1)}h`}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {walletDoor && oracleDoor ? (
          <p className="mt-3 text-sm text-mist">
            Comparación directa con el hallazgo: por la puerta de la billetera{" "}
            <strong className={walletDoor.roi && walletDoor.roi > 0 ? "text-profit" : "text-loss"}>
              {pct(walletDoor.roi, 1)}
            </strong>{" "}
            (el histórico decía +39,1%) · llegando al oráculo{" "}
            <strong className={oracleDoor.roi && oracleDoor.roi > 0 ? "text-profit" : "text-loss"}>
              {pct(oracleDoor.roi, 1)}
            </strong>{" "}
            (el histórico decía −7,8%).
          </p>
        ) : null}
      </Card>

      {b.byCategory.length ? (
        <Card title="Por categoría">
          <Table>
            <thead>
              <tr>
                <Th>Categoría</Th>
                <Th>n</Th>
                <Th>Acierto</Th>
                <Th>ROI</Th>
                <Th>PnL</Th>
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
                  <Td>
                    <PnlText value={c.pnl} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}

      <Card title="🚪 El embudo de entrada">
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

      <Card title="Historial completo de operaciones">
        {b.rows.length === 0 ? (
          <p className="text-sm text-mist">
            Todavía sin movimientos. El libro arranca vacío y solo cuenta señales de aquí en adelante — no hay atajo
            retroactivo honesto, porque el hallazgo se encontró en esos mismos datos.
          </p>
        ) : (
          <>
            <p className="mb-3 text-xs text-mist">
              Ordenado por hora de apertura. La columna CAPITAL avanza en el orden en que las posiciones{" "}
              <strong>cerraron</strong>, que no es el mismo — el capital actual es {money(b.capital)}.
            </p>
            <Table>
              <thead>
                <tr>
                  <Th>Abierta</Th>
                  <Th>Mercado</Th>
                  <Th>Brazo</Th>
                  <Th>Entrada</Th>
                  <Th>Puerta de salida</Th>
                  <Th>Retenida</Th>
                  <Th>PnL</Th>
                  <Th>Capital</Th>
                </tr>
              </thead>
              <tbody>
                {b.rows.slice(0, 200).map((r) => {
                  const st = STATUS_LABEL[r.status] ?? { text: r.status, className: "text-mist" };
                  return (
                    <tr key={r.id} className={r.status === "skipped" ? "opacity-60" : ""}>
                      <Td className="whitespace-nowrap text-mist">{when(r.openedAt)}</Td>
                      <Td>
                        <div className="max-w-md truncate text-bright">{r.marketQuestion ?? r.marketId}</div>
                        <div className="text-xs text-mist">
                          {r.outcome ?? ""}
                          {r.armConfluence > 1 ? (
                            <span className="ml-1 text-accent">🔗 {r.armConfluence} brazos</span>
                          ) : null}
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
                      <Td className={r.exitReason ? (DOOR_TONE[r.exitReason] ?? "text-mist") : st.className}>
                        {r.exitReason
                          ? (EXIT_DOOR_LABELS[r.exitReason as ExitDoor] ?? r.exitReason)
                          : st.text}
                      </Td>
                      <Td className="text-mist">{r.heldHours === null ? "—" : `${r.heldHours.toFixed(1)}h`}</Td>
                      <Td>
                        {r.realizedPnl === null ? <span className="text-mist">—</span> : <PnlText value={r.realizedPnl} />}
                      </Td>
                      <Td className="text-mist">{r.capitalAfter === null ? "—" : money(r.capitalAfter)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </>
        )}
      </Card>

      <Card title="Límites honestos de este libro">
        <ul className="space-y-2 text-sm text-mist">
          <li>
            <strong className="text-bright">El corte por tiempo es un número elegido, no medido.</strong> Las{" "}
            {TIME_STOP_HOURS}h salen del tiempo medio que aguantaban las posiciones rentables del histórico. Es una
            hipótesis razonable, no un óptimo demostrado.
          </li>
          <li>
            <strong className="text-bright">Salimos después que la billetera, no a la vez.</strong> Detectamos su venta
            en el siguiente ciclo, así que el precio ya se movió. El resultado ya incluye ese retraso, pero un ejecutor
            real podría ser más lento todavía.
          </li>
          <li>
            <strong className="text-bright">La venta grande no está medida.</strong> La entrada se cobra al precio real
            medido para ${FLAT_STAKE}; la salida usa el precio de mercado sin descontar que vender {FLAT_STAKE / 5}× más
            movería el libro en contra.
          </li>
          <li>
            <strong className="text-bright">Empieza en cero, hacia adelante.</strong> El +39,1% se midió sobre los
            mismos datos que revelaron el patrón. Solo esto, de aquí en adelante, es prueba limpia.
          </li>
        </ul>
        {b.startedAt ? <p className="mt-3 text-xs text-mist">Registrando desde {when(b.startedAt)}.</p> : null}
      </Card>
    </div>
  );
}
