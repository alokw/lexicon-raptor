# ---- Stage 1: build the web UI --------------------------------------------
FROM node:22-alpine AS web-build
WORKDIR /build
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server/ ./server/
COPY --from=web-build /build/dist ./web/dist

# Show data lives here — mount a volume to persist it.
ENV DATA_DIR=/app/data
VOLUME /app/data

ENV PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/api/health || exit 1

CMD ["node", "server/index.js"]
