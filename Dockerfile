# --- Build stage ---
FROM node:24-alpine AS builder
WORKDIR /app

# Toolchain for native modules (better-sqlite3) when no prebuilt binary exists
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY next-app/package.json ./next-app/
RUN npm ci

COPY . .
RUN npm run build

# --- Runtime stage ---
FROM node:24-alpine
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY next-app/package.json ./next-app/
RUN npm ci --omit=dev \
 && apk del python3 make g++ \
 && npm cache clean --force

COPY index.js ./
COPY lib ./lib
COPY next-app/app ./next-app/app
COPY next-app/components ./next-app/components
COPY next-app/lib ./next-app/lib
COPY next-app/auth.ts ./next-app/
COPY next-app/middleware.ts ./next-app/
COPY next-app/next.config.mjs ./next-app/
COPY next-app/tsconfig.json ./next-app/
COPY --from=builder /app/next-app/.next ./next-app/.next

# Persist accounts.json + sqlite under /data; mount a volume to survive restarts.
# HOST=0.0.0.0 is required so the container's port 8080 is reachable from outside.
# PORT is intentionally unset: Express defaults to 8080, Next.js to 3000. Setting
# it here would make both processes try to bind 8080.
ENV CLAUDE_SERVER_DATA_DIR=/data \
    DATABASE_PATH=/data/usage.db \
    HOST=0.0.0.0 \
    NODE_ENV=production

RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1

CMD ["npm", "start"]
