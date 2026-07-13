import { getDb } from "@/db/client";
import { getSourcingDesk } from "@/lib/queries";
import { SourcingDesk } from "../components/SourcingDesk";

export const dynamic = "force-dynamic";

export default function CazadorPage() {
  const db = getDb();
  const desk = getSourcingDesk(db, "fast-market");

  return (
    <SourcingDesk
      title="🎯 Cazador — scalpers de mercados rápidos"
      intro="Cazamos scalpers de verdad minando los mercados que RESUELVEN PRONTO (cualquier categoría: deporte de hoy, mercados de cierre cercano). Un mercado rápido obliga a hacer round-trips, así que quien VENDE ahí tradea la cuota. Nos quedamos con esos vendedores, los perfilamos y los que demuestren swing rentable entran solos al libro 🔁 Trade. Sección paralela de OBSERVACIÓN — no toca core, live ni trade. Solo datos reales."
      desk={desk}
      emptyHint="Aún no hay scalpers perfilados. El sourcing corre en el ciclo del operador (mina mercados que cierran pronto y guarda a los que venden); vuelve tras la próxima ronda."
      footnote="Nota honesta: si los vendedores minados no tienen edge de swing, la mesa quedará sin elegibles — también es un resultado. No inventamos actividad. Nunca se envían órdenes reales."
    />
  );
}
