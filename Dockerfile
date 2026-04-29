# --- Build stage ---
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY next-app/package.json ./next-app/
RUN npm ci

COPY . .
RUN npm run build

# --- Runtime stage ---
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY next-app/package.json ./next-app/
RUN npm ci --omit=dev

COPY index.js ./
COPY lib ./lib
COPY next-app/app ./next-app/app
COPY next-app/components ./next-app/components
COPY next-app/lib ./next-app/lib
COPY next-app/auth.ts ./next-app/
COPY next-app/middleware.ts ./next-app/
COPY next-app/next.config.ts ./next-app/
COPY next-app/tsconfig.json ./next-app/
COPY --from=builder /app/next-app/.next ./next-app/.next

EXPOSE 8080
CMD ["npm", "start"]
