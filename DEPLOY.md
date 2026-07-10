# Desplegar La Sombra en Railway (24/7)

La Sombra corre como **un solo servicio** en Railway: el dashboard web y el
operador (bucle en papel) viven en el mismo proceso. Esto es a propósito —
en Railway un **volumen** se monta a un único servicio, y la base de datos
SQLite necesita vivir en ese volumen. El operador corre dentro del web con un
temporizador (variable `OPERATOR_SCHEDULER=1`), sin bloquear la página.

> Sigue siendo **solo papel**: sin claves privadas, sin firmar, sin órdenes reales.

## Pasos

1. **Sube el repo a GitHub** (ya hecho si seguiste el flujo de la terminal).

2. En [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
   → elige el repo `la-sombra`. Railway detecta el `Dockerfile` automáticamente.

3. **Añade un volumen** (para que la BD no se borre en cada deploy):
   - En el servicio → pestaña **Volumes** → **New Volume**.
   - Mount path: `/data`

4. **Variables de entorno** (pestaña **Variables**):
   ```
   DATABASE_PATH=/data/la-sombra.db
   OPERATOR_SCHEDULER=1
   OPERATOR_INTERVAL_MINUTES=20
   TELEGRAM_BOT_TOKEN=<tu token>
   TELEGRAM_CHAT_ID=<tu chat id>
   ```
   (El `PORT` lo inyecta Railway solo; no lo pongas a mano.)

5. **Deploy**. Al arrancar corre `db:migrate` y luego `next start`. El primer
   tick del operador arranca ~15 s después; el primer tick de cada día tarda
   más porque perfila 25 billeteras contra la API real.

6. **Dominio público**: pestaña **Settings** → **Networking** → **Generate Domain**.
   Esa es la URL del dashboard, activa 24/7.

## Notas

- **Un servicio, un volumen**: no separes web y operador en dos servicios; no
  podrían compartir el archivo SQLite. Para escalar a multi-servicio habría que
  migrar a una BD remota (p. ej. Turso/libSQL).
- **Costo de tokens**: cero. Railway corre el bucle en su servidor; no usa la
  sesión de Claude Code ni consume tokens.
- **Apagar el operador** sin bajar la web: pon `OPERATOR_SCHEDULER=0` y
  redeploya.
- **Cambiar la frecuencia**: ajusta `OPERATOR_INTERVAL_MINUTES`.
