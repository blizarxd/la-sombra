import { getDb } from "@/db/client";
import { CAPITAL_START, FLAT_STAKE, VARIANTS } from "@/lib/capitalBook";
import { money, when } from "@/lib/format";
import { getCapitalBook, type CapitalBookView } from "@/lib/queries";
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

function BookColumn({ book, label, max }: { book: CapitalBookView; label: string; max: number }) {
  const growth = (book.capital - CAPITAL_START) / CAPITAL_START;
  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <h3 className="text-sm font-semibold text-bright">
        {label} <span className="font-normal text-mist">· máx {max} abiertas</span>
      </h3>
      <div className="mt-3 space-y-1">
        <div
          className={`text-3xl font-semibold ${
            book.capital > CAPITAL_START ? "text-profit" : book.capital < CAPITAL_START ? "text-loss" : "text-bright"
          }`}
        >
          {money(book.capital)}
        </div>
        <div className="text-xs text-mist">
          {growth >= 0 ? "+" : ""}
          {(growth * 100).toFixed(1)}% desde {money(CAPITAL_START)}
        </div>
      </div>
      <dl className="mt-4 space-y-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-mist">Liquidadas</dt>
          <dd className="text-bright">{book.settledCount}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-mist">Acierto</dt>
          <dd className="text-bright">{pct(book.winRate, 0)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-mist">ROI por apuesta</dt>
          <dd className={book.roi === null ? "text-mist" : book.roi > 0 ? "text-profit" : "text-loss"}>
            {pct(book.roi, 1)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-mist">Abiertas ahora</dt>
          <dd className="text-bright">
            {book.open.length} / {max}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-mist">Tomadas / saltadas</dt>
          <dd className="text-bright">
            {book.takenCount} / {book.skippedCount}
          </dd>
        </div>
      </dl>
      {book.skipReasons.length ? (
        <ul className="mt-3 space-y-0.5 border-t border-edge pt-3 text-xs text-mist">
          {book.skipReasons.map(([reason, n]) => (
            <li key={reason}>
              <span className="text-bright">{n}</span> — {SKIP_LABEL[reason] ?? reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function CapitalPage() {
  const db = getDb();
  const books = VARIANTS.map((v) => ({ v, book: getCapitalBook(db, v.id) }));
  const primary = books[0].book;
  const broken = books.find((b) => b.book.broken)?.book.broken ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-bright">💰 Libro de capital — la simulación con reglas reales</h1>
        <p className="mt-2 max-w-3xl text-sm text-mist">
          Los brazos copian un tamaño chico, sin billetera compartida y sin límite de cuántas posiciones corren a la vez.
          Eso sirve para <em>medir</em> una ventaja, no para estimar un retorno. Estos libros aplican lo que un dinero de
          verdad sí tiene:{" "}
          <strong className="text-bright">
            ${CAPITAL_START} de capital, ${FLAT_STAKE} plano por apuesta, una sola apuesta por mercado
          </strong>{" "}
          y un tope de posiciones abiertas.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-mist">
          Cada entrada se cobra al precio <strong>medido</strong> para ${FLAT_STAKE} en la escalera de profundidad, no al
          que pagó el brazo con su tamaño chico. Es el gemelo pesimista de los números de los brazos: si no coinciden,
          este está más cerca de lo que vería una cuenta.
        </p>
        <p className="mt-2 max-w-3xl text-xs text-mist">
          Estrategia de referencia: Esports + Cripto, banda 55-59¢, todos los brazos menos La Crema (que duplica copias
          de los demás). Solo papel — aquí no se envía ninguna orden.
        </p>
      </div>

      {broken ? (
        <Card title="⚠️ El libro no está registrando">
          <p className="text-sm text-loss">
            La consulta falló, así que esta página no puede decir nada. No es que no haya operaciones todavía — es que no
            se están leyendo.
          </p>
          <pre className="mt-2 overflow-x-auto rounded border border-edge bg-panel2 p-2 text-xs text-mist">{broken}</pre>
        </Card>
      ) : null}

      <div>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-mist">
          ⚖️ 3 contra 5 — el mismo flujo de señales, dos topes
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {books.map(({ v, book }) => (
            <BookColumn key={v.id} book={book} label={v.label} max={v.maxConcurrent} />
          ))}
        </div>
        <p className="mt-3 max-w-3xl text-sm text-mist">
          Si 3 protege o solo va lento no se decide discutiendo: el libro de 5 toma justo las señales que el de 3 rechaza
          por falta de cupo. En unos días la diferencia es un número. Ojo al ROI, no al capital — el de 5 opera más, así
          que puede acabar más arriba <em>y aun así</em> ser peor por apuesta.
        </p>
      </div>

      <Card title="🔗 ¿Sirve de algo que dos brazos coincidan?">
        <p className="mb-3 text-sm text-mist">
          Cuando dos brazos copian el mismo mercado, el libro toma <strong>una sola</strong> posición — una cuenta real
          no compra dos veces la misma apuesta, y duplicar gastaría un cupo que otro evento podría usar. Pero se anota la
          coincidencia, porque si predice mejor resultado, eso es una señal aprovechable.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Stat
            label="Con confluencia (2+ brazos)"
            value={primary.confluence.count ? pct(primary.confluence.roi, 1) : "—"}
            tone={
              primary.confluence.roi === null ? "neutral" : primary.confluence.roi > 0 ? "profit" : "loss"
            }
            hint={`${primary.confluence.count} liquidadas`}
          />
          <Stat
            label="De un solo brazo"
            value={primary.confluence.soloCount ? pct(primary.confluence.soloRoi, 1) : "—"}
            tone={
              primary.confluence.soloRoi === null ? "neutral" : primary.confluence.soloRoi > 0 ? "profit" : "loss"
            }
            hint={`${primary.confluence.soloCount} liquidadas`}
          />
        </div>
      </Card>

      <Card title="📏 Lo que cuesta el tamaño real">
        <p className="text-sm text-mist">
          Deslizamiento típico pagado por entrar con ${FLAT_STAKE} en vez del tamaño chico del brazo:{" "}
          <strong className="text-bright">
            {primary.medianSlippageCents === null ? "—" : `${primary.medianSlippageCents.toFixed(2)}¢`}
          </strong>
          . Ya está descontado de cada resultado de arriba.
        </p>
      </Card>

      <Card title={`Movimientos · libro de ${books[0].v.maxConcurrent}`}>
        {primary.rows.length === 0 ? (
          <p className="text-sm text-mist">
            Todavía sin movimientos. Los libros arrancaron limpios al añadirse la regla de no duplicar, así que empiezan
            vacíos y se llenan con lo que venga.
          </p>
        ) : (
          <>
            <p className="mb-3 text-xs text-mist">
              Ordenado por hora de apertura. La columna CAPITAL avanza en el orden en que las posiciones{" "}
              <strong>liquidaron</strong>, que no es el mismo — el capital actual es {money(primary.capital)}.
            </p>
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
                {primary.rows.slice(0, 100).map((r) => {
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
                          {r.exitReason ? ` · ${EXIT_LABEL[r.exitReason] ?? r.exitReason}` : ""}
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

      <Card title="Límites honestos de estos libros">
        <ul className="space-y-2 text-sm text-mist">
          <li>
            <strong className="text-bright">La salida no está medida.</strong> La entrada se cobra al precio real de $
            {FLAT_STAKE} porque medimos el lado de la compra del libro; para salir usamos el precio que consiguió el
            brazo con su tamaño chico. Vender {FLAT_STAKE / 5}× más podría sacar menos, así que el resultado sigue siendo
            algo optimista.
          </li>
          <li>
            <strong className="text-bright">Empieza hoy, no hace 9 días.</strong> Es forward-test: la muestra arranca en
            cero. Los +700% del cálculo retroactivo eran sobre los mismos días con los que se descubrió la banda; esto es
            la prueba limpia.
          </li>
          <li>
            <strong className="text-bright">Los dos libros no son independientes.</strong> Comparten señales, así que
            una racha buena o mala los mueve a la vez. Sirve para comparar el tope entre sí, no para tratarlos como dos
            pruebas separadas.
          </li>
          <li>
            <strong className="text-bright">Una orden real movería el precio.</strong> Medimos el libro en el instante
            de copiar, sin contar que meter ${FLAT_STAKE} de verdad afectaría al mercado.
          </li>
        </ul>
        {primary.startedAt ? <p className="mt-3 text-xs text-mist">Registrando desde {when(primary.startedAt)}.</p> : null}
      </Card>
    </div>
  );
}
