# La Sombra — single-service image for Railway.
# Runs the Next.js dashboard AND the in-process operator scheduler (paper only).
FROM node:20-slim

WORKDIR /app

# Toolchain for better-sqlite3 in case a prebuilt binary is unavailable.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install deps against the lockfile (dev deps included — needed to build Next
# and to run the tsx-based operator scripts at runtime).
COPY package.json package-lock.json ./
RUN npm ci

# App source (drizzle/ migrations included; data/ is volume-mounted at runtime).
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

ENV NODE_ENV=production
# DATABASE_PATH points at the Railway volume; overridable via env.
ENV DATABASE_PATH=/data/la-sombra.db
# Turn the operator loop on inside this service.
ENV OPERATOR_SCHEDULER=1

EXPOSE 3000
CMD ["npm", "run", "start:prod"]
