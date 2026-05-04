# Staging Environment — Design

**Date:** 2026-05-04
**Status:** Approved (ready for implementation plan)
**Scope:** Run a staging copy of the proxy on the same VPS as production, deployed automatically on push to a `staging` branch, with isolated data and its own public hostname.

---

## 1. Goals

- Push to `staging` branch → GitHub Actions deploys to `https://falconclaudestaging.duckdns.org` on the same VPS as prod.
- Staging and prod are fully isolated at the data layer (separate Docker volumes, separate SQLite DBs, separate Auth.js secrets).
- Staging shares the host with prod: same Caddy, same Docker engine, same SSH credentials, same Google OAuth client.
- A one-shot script can seed staging from prod (users + request_logs + analytics, **not** Claude account tokens).

## 2. Non-goals

- **No live shared state** between prod and staging. Anthropic's refresh-token rotation makes shared `accounts` rows actively dangerous (the first env to refresh invalidates the other's refresh token); we avoid this by never copying the `accounts` table.
- **No automated promotion** from staging to prod. Promotion is a manual `git merge staging → main && git push`.
- **No staging-specific Google OAuth client.** The prod client gets the staging callback URL added to its authorized redirects.
- **No periodic sync from prod.** The bootstrap script is run on-demand only.
- **No path-based or port-based routing.** Staging gets its own DuckDNS hostname so cookies, certs, and OAuth flows work identically to prod.

## 3. Architecture

```
                       Caddy (80/443, Let's Encrypt — one process)
                       ┌─────────────────────────────────────────┐
                       │ falconclaudeproxy.duckdns.org   → :8080 │  (prod)
                       │ falconclaudestaging.duckdns.org → :8081 │  (staging)
                       └─────────────────────────────────────────┘
                                    │                   │
                                    ▼                   ▼
  /opt/claude-server                      /opt/claude-server-staging
  ├─ git checkout: main                   ├─ git checkout: staging
  ├─ .env  (AUTH_URL=...proxy...)         ├─ .env  (AUTH_URL=...staging...)
  ├─ docker-compose.yml                   ├─ docker-compose.yml
  └─ container: claude-server             ├─ docker-compose.staging.yml (override)
       host port: 8080                    └─ container: claude-server-staging
       volume:    claude-data                  host port: 8081
                                               volume:    claude-data-staging
```

Both checkouts use the same `Dockerfile` and `docker-compose.yml`. Staging layers a small `docker-compose.staging.yml` override that renames the container, the volume, and remaps the host port.

## 4. File changes

### 4.1 New: `docker-compose.staging.yml` (committed to repo)

```yaml
services:
  claude-server:
    container_name: claude-server-staging
    ports:
      - "8081:8080"
    volumes:
      - claude-data-staging:/data

volumes:
  claude-data-staging:
```

### 4.2 New: `.github/workflows/deploy-staging.yml`

Mirrors `deploy.yml`, with these differences:

- `on.push.branches: [staging]`
- `concurrency.group: deploy-vps-staging` (independent of prod's `deploy-vps`)
- Step `env:` block injects `VPS_ENV_STAGING_CONTENT: ${{ secrets.VPS_ENV_STAGING }}`
- `with.envs: VPS_ENV_STAGING_CONTENT` so the SSH session sees it
- SSH script targets `/opt/claude-server-staging` and applies the staging compose override:

```bash
set -euo pipefail
cd /opt/claude-server-staging
git fetch --prune origin
git reset --hard origin/staging
umask 077
printf '%s' "$VPS_ENV_STAGING_CONTENT" > .env
docker compose -f docker-compose.yml -f docker-compose.staging.yml up -d --build
docker image prune -f
docker compose -f docker-compose.yml -f docker-compose.staging.yml ps
```

Reuses existing secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_PORT`.
New secret required: `VPS_ENV_STAGING`.

### 4.3 New: `scripts/bootstrap-staging-from-prod.sh`

Run **manually on the VPS**, not from CI. Idempotent — re-running resets staging from current prod and wipes any divergent staging-only data.

```bash
#!/usr/bin/env bash
set -euo pipefail

cd /opt/claude-server-staging

# 1. Stop staging so its DB is not being written
docker compose -f docker-compose.yml -f docker-compose.staging.yml down

# 2. Copy prod DB into staging volume via a throwaway alpine container,
#    then strip the accounts table.
docker run --rm \
  -v claude-data:/prod:ro \
  -v claude-data-staging:/staging \
  alpine sh -c '
    apk add --no-cache sqlite >/dev/null
    cp /prod/usage.db /staging/usage.db
    sqlite3 /staging/usage.db "DELETE FROM accounts;"
  '

# 3. Bring staging back up
docker compose -f docker-compose.yml -f docker-compose.staging.yml up -d
```

What is preserved: `users`, `user_tokens`, `request_logs`, `daily_usage`, and any other analytics tables.
What is wiped: `accounts` (Claude OAuth tokens).

### 4.4 No changes to existing files

`Dockerfile`, `docker-compose.yml`, `index.js`, `next-app/auth.ts`, and `.github/workflows/deploy.yml` are unchanged.

## 5. One-time setup steps (manual, on VPS and external services)

These run once during initial staging bring-up; they are not part of the design's automation surface but are documented here so the implementation plan can reference them.

1. **Register the second DuckDNS hostname** (`falconclaudestaging.duckdns.org`) and point it at the same VPS IP `161.97.150.95`.
2. **Add a second Caddy site block** to `/etc/caddy/Caddyfile`:
   ```
   falconclaudestaging.duckdns.org {
       reverse_proxy 127.0.0.1:8081
   }
   ```
   Reload Caddy.
3. **Add the staging callback URL** to the existing Google OAuth client in Google Cloud Console:
   `https://falconclaudestaging.duckdns.org/api/auth/callback/google`
4. **Create the `staging` branch on GitHub** from local: `git checkout -b staging && git push -u origin staging`.
5. **Clone the repo into `/opt/claude-server-staging`** on the VPS and check out staging:
   ```
   git clone https://github.com/trannam110702/claude-server.git /opt/claude-server-staging
   cd /opt/claude-server-staging && git checkout staging
   ```
6. **Create the `VPS_ENV_STAGING` GitHub secret** with staging's `.env` contents — same shape as `VPS_ENV`, but:
   - `AUTH_URL=https://falconclaudestaging.duckdns.org`
   - `AUTH_SECRET=<freshly generated, different from prod>`
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — same as prod
7. **First deploy:** push to `staging`. Workflow runs, container comes up empty.
8. **First bootstrap (optional, recommended):** run `scripts/bootstrap-staging-from-prod.sh` on the VPS to seed users + analytics from prod.
9. **Add a Claude account on staging** via `https://falconclaudestaging.duckdns.org/dashboard/accounts`.

## 6. Operational notes

- **Independent token refresh.** Each environment maintains its own Claude account rows with their own refresh tokens — no race between envs.
- **Concurrency group separation.** Prod and staging deploys never block each other. A staging deploy in progress does not delay a prod hotfix.
- **Image cache shared.** Both compose builds reuse Docker's layer cache, so staging builds are fast after prod has built.
- **Observability.** Both containers log to Docker; `docker logs claude-server` vs `docker logs claude-server-staging` distinguishes them. Caddy access logs (if enabled) distinguish by hostname.
- **Cookies / sessions.** Different `AUTH_SECRET` means a session cookie issued on prod cannot be reused on staging (and vice versa) — users sign in independently on each.
- **DB schema migrations.** Each env owns its own `usage.db`. A schema change merged to `staging` migrates only staging's DB; merging `staging → main` then migrates prod's DB on the next prod deploy. This is the entire point of having staging.

## 7. Promotion flow

```
local dev → push to `staging` → GitHub Actions → staging VPS dir → falconclaudestaging.duckdns.org
                                                                             │
                                                                       (manual verify)
                                                                             ▼
                            git checkout main && git merge staging && git push
                                                                             │
                                                                             ▼
                          GitHub Actions → prod VPS dir → falconclaudeproxy.duckdns.org
```

`staging` is a long-lived branch; merges flow `staging → main`, never the other direction (rebases on `staging` are fine).
