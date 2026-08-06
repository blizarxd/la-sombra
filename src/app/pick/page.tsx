import { getDb } from "@/db/client";
import { MAX_PICK_SPREAD, MIN_PICK_SCORE, comboMath } from "@/lib/dailyPick";
import { dayKeyTz, money, when } from "@/lib/format";
import { getDailyPicks } from "@/lib/queries";
import { Card, PnlText, Stat, Table, Td, Th } from "../components/ui";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  abierto: { label: "⏳ abierto", className: "text-mist" },
  ganado: { label: "✅ ganado", className: "text-profit" },
  perdido: { label: "❌ perdido", className: "text-loss" },
  anulado: { label: "⊘ anulado", className: "text-mist" },
};

export default function PickPage() {
  const db = getDb();
  const { picks, record, alternatesRecord } = getDailyPicks(db);
  const today = dayKeyTz(new Date());
  const todaysAll = picks.filter((p) => p.pickDate === today);
  const todays = todaysAll.find((p) => p.rank === 1) ?? null;
  const alternates = todaysAll.filter((p) => p.rank !== 1);

  // Every 2-leg combination of today's shortlist, with the cost made explicit
  // at the exact moment someone is deciding whether to staple two together.
  const pairs = todaysAll.flatMap((a, i) =>
    todaysAll.slice(i + 1).map((b) => ({ a, b, m: comboMath(a, b) })),
  );

  // The comparison that decides whether this is a business: you must win as
  // often as the price implies just to stand still.
  const beatsBreakEven =
    record.winRate !== null && record.breakEvenRate !== null ? record.winRate > record.breakEvenRate : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-white">🎯 El Pick del Día</h1>
        <p className="mt-1 text-sm text-mist">
          Una sola selección al día, congelada <b className="text-white">antes</b> de saber el resultado, al precio que
          costaría de verdad. Registro público en papel — aquí están todos los picks, ganados y perdidos.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Acierto"
          value={record.winRate === null ? "—" : `${(record.winRate * 100).toFixed(0)}%`}
          hint={
            record.winRateFloor === null
              ? `${record.settled} liquidados`
              : `piso ${(record.winRateFloor * 100).toFixed(0)}% · ${record.settled} liquidados`
          }
        />
        <Stat
          label="Necesario para empatar"
          value={record.breakEvenRate === null ? "—" : `${(record.breakEvenRate * 100).toFixed(0)}%`}
          hint="según el precio medio pagado"
        />
        <Stat
          label="PnL por $10 fijos"
          value={money(record.totalPnl)}
          hint={record.roiFloor === null ? `ROI ${(record.roi * 100).toFixed(1)}%` : `ROI ${(record.roi * 100).toFixed(1)}% · piso ${(record.roiFloor * 100).toFixed(1)}%`}
        />
        <Stat label="Peor racha" value={`${record.worstStreak} seguidos`} hint={`${record.open} abiertos · ${record.total} picks en total`} />
      </div>

      <Card title="📌 Hoy">
        {todays ? (
          <div className="space-y-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-profit">🥇 Pick del día</p>
              <p className="text-base font-medium text-white">{todays.marketQuestion ?? todays.marketId}</p>
              <p className="text-sm text-mist">
                Lado <b className="text-white">{todays.outcome ?? "?"}</b> · entrada{" "}
                <b className="text-white">{Math.round(todays.entryPrice * 100)}¢</b>
                {todays.spread !== null ? ` · spread pagado ${(todays.spread * 100).toFixed(1)}¢` : ""} · publicado{" "}
                {when(todays.publishedAt)}
              </p>
              <p className="mt-1 text-[11px] leading-4 text-mist">{todays.reasoning}</p>
            </div>

            {alternates.length > 0 ? (
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-mist">
                  Alternativas ({alternates.length}) — mismo estándar, no cuentan para el historial
                </p>
                <Table>
                  <thead>
                    <tr>
                      <Th>#</Th>
                      <Th>Mercado</Th>
                      <Th>Lado</Th>
                      <Th className="text-right">Entrada</Th>
                      <Th>Celda</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {alternates.map((p) => (
                      <tr key={p.id} className="border-t border-edge">
                        <Td className="text-mist">{p.rank}</Td>
                        <Td className="max-w-[20rem] truncate text-white">{p.marketQuestion ?? p.marketId}</Td>
                        <Td className="text-mist">{p.outcome ?? "—"}</Td>
                        <Td className="text-right tabular-nums text-mist">{Math.round(p.entryPrice * 100)}¢</Td>
                        <Td className="text-mist">{p.cellLabel ?? "—"}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-mist">
            <b className="text-white">Hoy no hay pick.</b> Ninguna señal del día superó el estándar (puntaje ≥{" "}
            {MIN_PICK_SCORE}, celda de oro confirmada detrás, spread ≤ {(MAX_PICK_SPREAD * 100).toFixed(0)}¢). Esto es a
            propósito: forzar un pick cada día es justo como se llena un historial de monedas al aire.
          </p>
        )}
      </Card>

      {pairs.length > 0 ? (
        <Card title="🧮 Si quieres combinar dos — la cuenta antes de hacerlo">
          <div className="rounded border border-edge bg-black/20 p-2 text-[11px] leading-4 text-mist">
            <b className="text-white">Ojo, esto primero:</b> comprar dos picks por separado <b>NO</b> es una combinada.
            Dos apuestas sueltas pagan cada una por su lado (eso es diversificar, y baja la varianza). Una combinada de
            verdad exige que <b className="text-white">acierten las dos</b> y paga multiplicado — es la apuesta
            contraria. Para armarla necesitas el creador de combos de Polymarket, no dos compras sueltas.
          </div>
          <Table>
            <thead>
              <tr>
                <Th>Combinación</Th>
                <Th className="text-right">Precio</Th>
                <Th className="text-right">Paga</Th>
                <Th className="text-right">Aciertan las 2</Th>
                <Th className="text-right">Peaje doble</Th>
                <Th className="text-right">EV /$10</Th>
              </tr>
            </thead>
            <tbody>
              {pairs.map(({ a, b, m }) => (
                <tr key={`${a.id}-${b.id}`} className="border-t border-edge">
                  <Td className="text-white">
                    #{a.rank} + #{b.rank}
                    <span className="ml-1 text-mist">
                      ({Math.round(a.entryPrice * 100)}¢ × {Math.round(b.entryPrice * 100)}¢)
                    </span>
                  </Td>
                  <Td className="text-right tabular-nums text-white">{(m.combinedPrice * 100).toFixed(0)}¢</Td>
                  <Td className="text-right tabular-nums text-mist">{m.multiple.toFixed(2)}x</Td>
                  <Td className="text-right tabular-nums text-mist">{(m.bothLandRate * 100).toFixed(0)}%</Td>
                  <Td className="text-right tabular-nums text-mist">
                    {m.spreadDrag === null ? "—" : `${(m.spreadDrag * 100).toFixed(1)}%`}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {m.evPer10 === null ? <span className="text-mist">—</span> : <PnlText value={m.evPer10} />}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-[11px] leading-4 text-mist">
            <b className="text-white">Cómo leer la última columna:</b> es lo que esperas ganar (o perder) por cada $10
            en una combinada de verdad, valorando cada pata a su precio medio. Sale negativa siempre por una razón
            estructural: <b className="text-white">cada pata paga su spread y los dos se multiplican</b>. Por eso
            existen las combinadas — no porque sean buenas, sino porque el premio grande se vende solo. Con estos
            números necesitas que las dos patas tengan ventaja REAL solo para volver a cero.
          </p>
        </Card>
      ) : null}

      <Card title="📊 Cómo va — el marcador honesto">
        {record.settled === 0 ? (
          <p className="text-sm text-mist">Todavía no hay picks liquidados. El marcador aparece en cuanto resuelva el primero.</p>
        ) : (
          <p className="text-sm text-mist">
            {record.won} ganados y {record.lost} perdidos de {record.settled} liquidados ={" "}
            <b className="text-white">{((record.winRate ?? 0) * 100).toFixed(0)}% de acierto</b>. Pero el número que
            decide es la comparación: al precio medio que pagamos ({((record.breakEvenRate ?? 0) * 100).toFixed(0)}¢)
            hace falta acertar el <b className="text-white">{((record.breakEvenRate ?? 0) * 100).toFixed(0)}%</b> solo
            para no perder.{" "}
            {beatsBreakEven === null ? null : beatsBreakEven ? (
              <b className="text-profit">Vamos por encima del punto de equilibrio.</b>
            ) : (
              <b className="text-loss">Vamos por debajo: con este historial esto pierde dinero.</b>
            )}{" "}
            Con {record.settled} liquidados{record.settled < 30 ? " la muestra todavía es demasiado corta para concluir nada" : ""}
            .
          </p>
        )}
        <p className="mt-2 text-[11px] leading-4 text-mist">
          <b className="text-white">Por qué el piso y no el titular:</b> acertar 3 de 3 no es 100% de fiabilidad. El
          piso es la cota inferior — lo peor que plausiblemente somos dado el tamaño de la muestra. Es el número por el
          que deberías juzgarnos, y el que ningún tipster enseña.
        </p>
      </Card>

      <Card title="🗂️ Historial completo">
        {picks.length === 0 ? (
          <p className="text-sm text-mist">Sin picks todavía. El primero se congela en el corte de las 8am.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Día</Th>
                <Th>Mercado</Th>
                <Th>Lado</Th>
                <Th className="text-right">Entrada</Th>
                <Th>Celda</Th>
                <Th className="text-right">Resultado</Th>
                <Th className="text-right">PnL /$10</Th>
              </tr>
            </thead>
            <tbody>
              {picks.map((p) => {
                const st = STATUS_STYLE[p.status] ?? { label: p.status, className: "text-mist" };
                return (
                  <tr key={p.id} className="border-t border-edge">
                    <Td className="whitespace-nowrap text-mist">{p.pickDate}</Td>
                    <Td className="max-w-[22rem] truncate text-white">{p.marketQuestion ?? p.marketId}</Td>
                    <Td className="text-mist">{p.outcome ?? "—"}</Td>
                    <Td className="text-right tabular-nums text-mist">{Math.round(p.entryPrice * 100)}¢</Td>
                    <Td className="text-mist">{p.cellLabel ?? "—"}</Td>
                    <Td className={`text-right ${st.className}`}>{st.label}</Td>
                    <Td className="text-right tabular-nums">
                      {p.pnlPer10 === null ? <span className="text-mist">—</span> : <PnlText value={p.pnlPer10} />}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="⚠️ Léelo antes de usarlo para nada">
        <ul className="space-y-1 text-[11px] leading-4 text-mist">
          <li>
            · <b className="text-white">Esto es investigación en papel, no consejo financiero.</b> Ningún pick se opera
            con dinero real y el sistema no tiene forma de colocar una orden.
          </li>
          <li>
            · El precio es el <b className="text-white">ask</b> al publicar: lo que costaría de verdad, spread incluido.
            Marcar al medio es como un historial perdedor se maquilla de plano.
          </li>
          <li>
            · Un pick <b className="text-white">no se re-elige jamás</b>: hay un índice único por día en la base. Los
            perdedores son parte del historial y no se pueden borrar.
          </li>
          <li>
            · Todavía <b className="text-white">no hay ventaja demostrada</b>. Esta página existe para comprobar si la
            hay, no para afirmar que la tenemos. Si a los 30-60 días el piso sigue bajo cero, la respuesta es que no.
          </li>
        </ul>
      </Card>
    </div>
  );
}
