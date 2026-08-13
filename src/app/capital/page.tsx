import { getDb } from "@/db/client";
import { CAPITAL_START, FLAT_STAKE, MAX_CONCURRENT } from "@/lib/capitalBook";
import { money, when } from "@/lib/format";
import { getCapitalBook } from "@/lib/queries";
import { Card, PnlText, Stat, Table, Td, Th } from "../components/ui";

export const dynamic = "force-dynamic";

const SKIP_LABEL: Record<string, string> = {
  concurrencia: `ya había ${MAX_CONCURRENT} posiciones abiertas`,
  capital: "no quedaba efectivo para la apuesta",
  "libro-fino": `el libro no absorbía $${FLAT_STAKE}`,
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

export default function CapitalPage() {
  const db = getDb();
  const b = getCapitalBook(db);
  const growth = (b.capital - CAPITAL_START) / CAPITAL_START;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-bright">💰 Libro de capital — la simulación con reglas reales</h1>
        <p className="mt-2 max-w-3xl text-sm text-mist">
          Los brazos copian un tamaño chico, sin billetera compartida y sin límite de cuántas posiciones corren a la vez.
          Eso sirve para <em>medir</em> una ventaja, no para estimar un retorno. Este libro aplica las tres restricciones
          que un dinero de verdad sí tiene:{" "}
          <strong className="text-bright">
            ${CAPITAL_START} de capital, ${FLAT_STAKE} plano por apuesta, máximo {MAX_CONCURRENT} posiciones abiertas
          </strong>
          .
        </p>
        <p className="mt-2 max-w-3xl text-sm text-mist">
          Cada entrada se cobra al precio <strong>medido</strong> para ${FLAT_STAKE} en la escalera de profundidad, no al
          precio que pagó el brazo con su tamaño chico. Es el gemelo pesimista de los números de los brazos: si no
          coinciden, este está más cerca de lo que vería una cuenta.
        </p>
        <p className="mt-2 max-w-3xl text-xs text-mist">
          Estrategia de referencia: Esports + Cripto, banda de entrada 55-59¢, todos los brazos menos La Crema (que
          duplica copias de los demás). Solo papel — aquí no se envía ninguna orden.
        </p>
      </div>

      {b.broken ? (
        <Card title="⚠️ El libro no está registrando">
          <p className="text-sm text-loss">
            La consulta falló, así que esta página no puede decir nada. No es que no haya operaciones todavía — es que no
            se están leyendo.
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
          label="Operaciones liquidadas"
          value={String(b.settledCount)}
          hint={b.winRate !== null ? `${pct(b.winRate, 0)} de acierto` : "aún ninguna"}
        />
        <Stat
          label="ROI por apuesta"
          value={b.roi === null ? "—" : pct(b.roi, 1)}
          tone={b.roi === null ? "neutral" : b.roi > 0 ? "profit" : "loss"}
          hint={`sobre ${money(FLAT_STAKE)} por operación`}
        />
        <Stat
          label="Abiertas ahora"
          value={`${b.open.length} / ${MAX_CONCURRENT}`}
          hint={`${money(b.committed)} comprometidos · ${money(b.freeCapital)} libres`}
        />
      </div>

      <Card title="🚪 El embudo — cuánto cuestan las reglas">
        <p className="mb-3 text-sm text-mist">
          El número que decide si las reglas son demasiado estrictas. Una señal saltada no es un fallo: es el precio de
          operar con capital finito, y hay que verlo para poder juzgarlo.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Señales vistas" value={String(b.seenCount)} hint="que cumplían la estrategia" />
          <Stat label="Tomadas" value={String(b.takenCount)} tone="profit" />
          <Stat
            label="Saltadas"
            value={String(b.skippedCount)}
            tone={b.skippedCount > b.takenCount ? "watch" : "neutral"}
            hint={
              b.seenCount ? `${((b.skippedCount / b.seenCount) * 100).toFixed(0)}% de las señales` : undefined
            }
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

      <Card title="📏 Lo que cuesta el tamaño real">
        <p className="text-sm text-mist">
          Deslizamiento típico pagado por entrar con ${FLAT_STAKE} en vez del tamaño chico del brazo:{" "}
          <strong className="text-bright">
            {b.medianSlippageCents === null ? "—" : `${b.medianSlippageCents.toFixed(2)}¢`}
          </strong>
          . Ya está descontado de cada resultado de arriba.
        </p>
      </Card>

      <Card title="Movimientos">
        {b.rows.length === 0 ? (
          <p className="text-sm text-mist">
            Todavía sin movimientos. El libro solo mira copias abiertas desde que se instrumentó la profundidad, así que
            empieza vacío y se llena con lo que venga.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Abierta</Th>
                <Th>Mercado</Th>
                <Th>Brazo</Th>
                <Th>Entrada brazo</Th>
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
                        {r.status === "skipped" && r.skipReason
                          ? ` · ${SKIP_LABEL[r.skipReason] ?? r.skipReason}`
                          : ""}
                      </div>
                    </Td>
                    <Td className="text-mist">{r.sourceTrack}</Td>
                    <Td className="text-mist">{(r.armEntryPrice * 100).toFixed(0)}¢</Td>
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
            <strong className="text-bright">La salida no está medida.</strong> La entrada se cobra al precio real de $
            {FLAT_STAKE} porque medimos el lado de la venta del libro; para salir usamos el precio que consiguió el
            brazo con su tamaño chico. Vender {FLAT_STAKE / 5}× más podría sacar menos, así que el resultado sigue
            siendo algo optimista.
          </li>
          <li>
            <strong className="text-bright">Empieza hoy, no hace 9 días.</strong> Es forward-test: la muestra arranca en
            cero y solo cuenta lo que pase de ahora en adelante. Los +700% del cálculo retroactivo eran sobre los mismos
            días con los que se descubrió la banda; esto es la prueba limpia.
          </li>
          <li>
            <strong className="text-bright">Una orden real movería el precio.</strong> Medimos el libro en el instante
            de copiar, sin contar que meter ${FLAT_STAKE} de verdad afectaría al mercado.
          </li>
        </ul>
        {b.startedAt ? <p className="mt-3 text-xs text-mist">Registrando desde {when(b.startedAt)}.</p> : null}
      </Card>
    </div>
  );
}
