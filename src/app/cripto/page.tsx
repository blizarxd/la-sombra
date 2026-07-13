import { getDb } from "@/db/client";
import { getSourcingDesk } from "@/lib/queries";
import { SourcingDesk } from "../components/SourcingDesk";

export const dynamic = "force-dynamic";

export default function CriptoPage() {
  const db = getDb();
  const desk = getSourcingDesk(db, "crypto-market");

  return (
    <SourcingDesk
      title="₿ Cripto — mesa de observación"
      intro="El leaderboard de ganancias solo muestra HOLDERS. Aquí minamos billeteras directamente de los mercados de cripto más activos (Polymarket tag «Crypto»). Las descubiertas se perfilan y, si demuestran buen swing, entran solas a los libros existentes (Trade / En Vivo). Es una mesa de OBSERVACIÓN, no un libro de papel aparte. Solo datos reales."
      desk={desk}
      emptyHint="Aún no hay billeteras cripto perfiladas. El sourcing corre en el ciclo del operador (mina los mercados cripto más activos); vuelve tras la próxima ronda de perfilado."
      footnote="Nota honesta: si estas billeteras resultan no tener edge de swing, la mesa lo mostrará vacía de elegibles — y eso también es un resultado. No inventamos actividad. Nunca se envían órdenes reales."
    />
  );
}
