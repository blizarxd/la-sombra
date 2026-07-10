import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ruleChanges, ruleSets } from "@/db/schema";
import type { Rules } from "@/lib/rules";
import { when } from "@/lib/format";
import { Badge, Card, Empty, Table, Td, Th } from "../components/ui";

export const dynamic = "force-dynamic";

const thresholdLabels: [keyof Rules, string, string][] = [
  ["maxEntryPrice", "Precio máx. de entrada", "descarta COMPRAS en papel por encima de este ask (disciplina de banda de entrada)"],
  ["minEntryPrice", "Precio mín. de entrada", "descarta entradas tipo lotería por debajo de esto"],
  ["maxPriceDrift", "Deriva máx. de precio", "guardia de entrada tardía: descarta si el precio se movió más desde la entrada de la billetera"],
  ["maxSpread", "Spread máximo", "descarta libros más anchos que esto"],
  ["minLiquidity", "Liquidez mín. ($)", "descarta mercados más delgados que esto"],
  ["minTimeToResolutionHours", "Tiempo mín. a resolución (h)", "evita entradas de último minuto"],
  ["maxTimeToResolutionHours", "Tiempo máx. a resolución (h)", "evita capital estacionado por meses"],
  ["minWalletGlobalScore", "Puntaje mín. de billetera", "solo copia billeteras por encima de este puntaje global"],
  ["minResolvedTrades", "Trades resueltos mín.", "requisito de historial de la billetera"],
  ["oneHitWonderShareThreshold", "Proporción de golpe de suerte", "proporción de ganancia del mejor trade que dispara la penalización"],
  ["paperCopyThreshold", "Umbral de copia en papel", "puntaje de copia necesario para abrir un trade en papel"],
  ["watchlistThreshold", "Umbral de vigilancia", "puntaje de copia necesario para poner en vigilancia"],
  ["minPositionSize", "Posición mín. ($)", "piso del tamaño simulado"],
  ["maxPositionSize", "Posición máx. ($)", "techo del tamaño simulado"],
];

export default function RulesPage() {
  const db = getDb();
  const active = db.select().from(ruleSets).where(eq(ruleSets.active, true)).get();
  const versions = db.select().from(ruleSets).orderBy(desc(ruleSets.version)).all();
  const changes = db.select().from(ruleChanges).orderBy(desc(ruleChanges.createdAt)).all();
  const rules: Rules | null = active ? JSON.parse(active.rulesJson) : null;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Reglas</h1>
        <p className="text-sm text-mist">
          El ciclo de automejora ajusta estas reglas automáticamente (solo papel, pasos acotados) — cada cambio queda versionado con motivo, evidencia, antes y después.
        </p>
      </header>

      {!rules || !active ? (
        <Empty>
          Reglas sin inicializar. Corre <code className="text-accent">npm run seed</code>.
        </Empty>
      ) : (
        <>
          <Card title={`Umbrales activos — set de reglas v${active.version} (desde ${when(active.createdAt)})`}>
            <Table>
              <thead>
                <tr>
                  <Th>Regla</Th>
                  <Th className="text-right">Valor</Th>
                  <Th>Qué hace</Th>
                </tr>
              </thead>
              <tbody>
                {thresholdLabels.map(([key, label, help]) => (
                  <tr key={key}>
                    <Td className="font-medium">{label}</Td>
                    <Td className="text-right font-semibold text-accent">{String(rules[key])}</Td>
                    <Td className="text-xs text-mist">{help}</Td>
                  </tr>
                ))}
                <tr>
                  <Td className="font-medium">Pesos del puntaje de trade</Td>
                  <Td className="text-right" />
                  <Td className="text-xs text-mist">
                    {Object.entries(rules.tradeWeights).map(([k, v]) => `${k} ${v}`).join(" · ")}
                  </Td>
                </tr>
                <tr>
                  <Td className="font-medium">Pesos del puntaje de billetera</Td>
                  <Td className="text-right" />
                  <Td className="text-xs text-mist">
                    {Object.entries(rules.walletWeights).map(([k, v]) => `${k} ${v}`).join(" · ")}
                  </Td>
                </tr>
              </tbody>
            </Table>
          </Card>

          <Card title={`Cambios automáticos (${changes.length})`}>
            {changes.length === 0 ? (
              <div className="text-sm text-mist">
                Aún no hay cambios automáticos. update:rules ajusta umbrales solo cuando hay al menos 5-10 resultados resueltos como evidencia.
              </div>
            ) : (
              <div className="space-y-3">
                {changes.map((c) => (
                  <div key={c.id} className="rounded-lg bg-panel2 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge value="resolved" />
                      <span className="font-semibold">{c.reason}</span>
                      <span className="ml-auto text-xs text-mist">{when(c.createdAt)} · por {c.changedBy}</span>
                    </div>
                    <div className="mt-1 text-xs text-mist">Evidencia: {c.evidenceSummary}</div>
                    <div className="mt-1 text-xs">
                      <span className="text-loss">antes {c.beforeJson}</span>{" "}
                      <span className="text-profit">después {c.afterJson}</span>
                    </div>
                    {c.expectedImprovement ? (
                      <div className="mt-1 text-xs text-mist">Esperado: {c.expectedImprovement}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Historial de versiones">
            <ul className="space-y-1 text-sm">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center gap-2">
                  <span className={v.active ? "font-semibold text-accent" : "text-mist"}>v{v.version}</span>
                  {v.active ? <Badge value="track" /> : null}
                  <span className="text-xs text-mist">creado {when(v.createdAt)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
