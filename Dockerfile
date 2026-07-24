# No runtime dependencies, so there is nothing to install — just Node and the source.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/app.db \
    TRUST_PROXY=1

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY scripts ./scripts

# Persistent volume mount point for the SQLite file.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

# Seeding is idempotent: it creates the demo accounts once and then no-ops.
CMD ["sh", "-c", "node scripts/seed.js && node src/server.js"]
