# Staging Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a staging copy of the proxy on the same VPS as production, deployed automatically on push to a `staging` branch, with isolated data, an isolated `.env`, and its own DuckDNS hostname.

**Architecture:** A new `docker-compose.staging.yml` override renames the container, the host port, and the volume so a second compose project can run alongside prod on the same Docker engine. A new GitHub Actions workflow (`deploy-staging.yml`) triggers on push to `staging`, SSHes into the VPS, and deploys to `/opt/claude-server-staging` using the override. A manual one-shot script (`bootstrap-staging-from-prod.sh`) seeds staging's volume from prod's `usage.db` while wiping the `accounts` table to avoid Anthropic refresh-token rotation races.

**Tech Stack:** Docker Compose v2, GitHub Actions (`appleboy/ssh-action@v1.2.0`), Caddy (already installed on VPS), DuckDNS (free dynamic DNS), bash, sqlite3.

**Reference:** `docs/superpowers/specs/2026-05-04-staging-environment-design.md`

---

## File map

**Create:**
- `docker-compose.staging.yml` — compose override applied only by the staging deploy
- `scripts/bootstrap-staging-from-prod.sh` — manual one-shot DB seed (run on VPS)
- `.github/workflows/deploy-staging.yml` — push-to-staging deploy workflow

**Modify:** none.

The existing `Dockerfile`, `docker-compose.yml`, `index.js`, `next-app/auth.ts`, and `.github/workflows/deploy.yml` are unchanged. Both checkouts (prod and staging) build from the same source — staging just layers the override file on top of the base compose file.

---

## Task 1: Compose override for staging

**Files:**
- Create: `docker-compose.staging.yml`

This file is committed to `main` so that when the `staging` branch is created from `main` it inherits the override. The base `docker-compose.yml` is unchanged; the override only redefines the fields that need to differ.

- [ ] **Step 1: Create the override file**

Create `docker-compose.staging.yml`:

```yaml
services:
  claude-server:
    container_name: claude-server-staging
    ports: !override
      - "8081:8080"
    volumes: !override
      - claude-data-staging:/data

volumes:
  claude-data-staging:
```

The `!override` tag (Compose v2.20+) replaces the parent's list entirely. Without it, the staging container would inherit `8080:8080` from the base file's ports list (since Compose merges lists by appending) and fail to start on the VPS because prod already owns port 8080.

- [ ] **Step 2: Locally verify the merged compose config parses**

Run: `docker compose -f docker-compose.yml -f docker-compose.staging.yml config`

Expected: prints the merged config without errors. The merged output should show **exactly one** entry under `ports` (`published: "8081"`) and **exactly one** entry under the service's `volumes` (`source: claude-data-staging`). If you see two ports or two volumes, the `!override` tag was not applied — check Compose version.

If `docker` is not installed locally, skip — the same command runs on the VPS during the first deploy and any error there will be caught.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.staging.yml
git commit -m "feat(staging): add docker-compose override for staging environment"
```

---

## Task 2: Bootstrap-from-prod script

**Files:**
- Create: `scripts/bootstrap-staging-from-prod.sh`

This script is committed to `main` so it ships in both checkouts; it is run **manually on the VPS** when staging needs to be seeded (or reset) from current prod. It is idempotent — re-running wipes any divergent staging-only data and replays from prod.

- [ ] **Step 1: Create the scripts directory if it does not exist**

Run: `mkdir -p scripts`

- [ ] **Step 2: Create the bootstrap script**

Create `scripts/bootstrap-staging-from-prod.sh`:

```bash
#!/usr/bin/env bash
#
# Seed (or reset) the staging Docker volume from the current prod usage.db.
# Idempotent — running it again at any time refreshes staging from prod and
# wipes any staging-only data that has diverged.
#
# What is preserved: users, user_tokens, request_logs, daily_usage, and any
# other analytics tables.
# What is wiped: the accounts table — Claude OAuth tokens are NOT shared
# between envs because Anthropic rotates refresh tokens on every successful
# refresh, and shared rows would cause the two environments to invalidate
# each other's tokens.
#
# Run from /opt/claude-server-staging on the VPS.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f docker-compose.staging.yml ]; then
  echo "error: docker-compose.staging.yml not found in $(pwd)" >&2
  echo "run this script from /opt/claude-server-staging" >&2
  exit 1
fi

echo "==> stopping staging container..."
docker compose -f docker-compose.yml -f docker-compose.staging.yml down

echo "==> copying prod usage.db into staging volume and wiping accounts table..."
docker run --rm \
  -v claude-data:/prod:ro \
  -v claude-data-staging:/staging \
  alpine sh -c '
    apk add --no-cache sqlite >/dev/null
    cp /prod/usage.db /staging/usage.db
    sqlite3 /staging/usage.db "DELETE FROM accounts;"
    echo "==> tables remaining:"
    sqlite3 /staging/usage.db ".tables"
    echo "==> accounts row count (expect 0):"
    sqlite3 /staging/usage.db "SELECT COUNT(*) FROM accounts;"
  '

echo "==> starting staging container..."
docker compose -f docker-compose.yml -f docker-compose.staging.yml up -d

echo "==> done. staging seeded from prod, accounts cleared."
echo "==> add a Claude account at https://falconclaudestaging.duckdns.org/dashboard/accounts"
```

- [ ] **Step 3: Make the script executable**

Run: `chmod +x scripts/bootstrap-staging-from-prod.sh`

(On Windows, `chmod` may be a no-op. Git tracks the executable bit via `core.fileMode`; if the file lands non-executable on the VPS, fix it there with `chmod +x scripts/bootstrap-staging-from-prod.sh`.)

- [ ] **Step 4: Verify the script parses with bash**

Run: `bash -n scripts/bootstrap-staging-from-prod.sh`

Expected: no output, exit code 0. (Syntax check only — does not execute.)

If `bash` is not on PATH on Windows, use Git Bash or skip and rely on the VPS to surface syntax errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/bootstrap-staging-from-prod.sh
git commit -m "feat(staging): add bootstrap-from-prod script for staging volume"
```

---

## Task 3: GitHub Actions workflow for staging deploys

**Files:**
- Create: `.github/workflows/deploy-staging.yml`

Mirrors the existing `.github/workflows/deploy.yml` with three differences: the trigger branch is `staging`, the concurrency group is `deploy-vps-staging`, and the env file content comes from a new secret `VPS_ENV_STAGING`. The SSH script targets `/opt/claude-server-staging` and applies the compose override.

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/deploy-staging.yml`:

```yaml
name: Deploy (staging)

on:
  push:
    branches: [staging]
  workflow_dispatch:

concurrency:
  group: deploy-vps-staging
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy over SSH
        uses: appleboy/ssh-action@v1.2.0
        env:
          VPS_ENV_STAGING_CONTENT: ${{ secrets.VPS_ENV_STAGING }}
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          port: ${{ secrets.VPS_PORT || 22 }}
          envs: VPS_ENV_STAGING_CONTENT
          script_stop: true
          script: |
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

- [ ] **Step 2: Verify the workflow YAML parses**

Run (PowerShell):

```powershell
node -e "console.log(require('js-yaml').load(require('fs').readFileSync('.github/workflows/deploy-staging.yml','utf8')).name)"
```

Expected: prints `Deploy (staging)`.

If `js-yaml` is not installed, alternative check (PowerShell):

```powershell
node -e "JSON.parse(JSON.stringify(require('yaml').parse(require('fs').readFileSync('.github/workflows/deploy-staging.yml','utf8')))); console.log('ok')"
```

If neither YAML parser is available, skip — GitHub will surface the parse error on the first push.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-staging.yml
git commit -m "ci(staging): add deploy-staging workflow triggered on staging branch"
```

---

## Task 4: One-time external setup (manual, owner-only)

These steps cannot be automated by the agent — they require operator access to DuckDNS, Google Cloud Console, the VPS root account, and GitHub secrets. They are listed in execution order. Do **not** push the `staging` branch until every step in this task is complete.

- [ ] **Step 1: Register the second DuckDNS hostname**

Sign in to https://www.duckdns.org and create a new subdomain `falconclaudestaging`. Set its IP to `161.97.150.95`. Wait for DNS propagation (`nslookup falconclaudestaging.duckdns.org` should return that IP).

- [ ] **Step 2: Add a Caddy site block for staging**

SSH into the VPS as root. Edit `/etc/caddy/Caddyfile` and append:

```
falconclaudestaging.duckdns.org {
    reverse_proxy 127.0.0.1:8081
}
```

Reload Caddy:

```bash
systemctl reload caddy
```

Verify Caddy parses the config and got a Let's Encrypt cert (may take ~30s):

```bash
journalctl -u caddy --since "1 minute ago" --no-pager | tail -20
curl -I https://falconclaudestaging.duckdns.org
```

Expected: `journalctl` shows certificate obtained for the new hostname; `curl -I` returns a 502 (because port 8081 has nothing on it yet) but TLS handshake succeeds.

- [ ] **Step 3: Add the staging callback URL to the Google OAuth client**

Go to https://console.cloud.google.com/apis/credentials. Open the OAuth 2.0 Client ID currently used by prod. Under **Authorized redirect URIs**, click **+ ADD URI** and add:

```
https://falconclaudestaging.duckdns.org/api/auth/callback/google
```

Save. Allow up to 5 minutes for the change to propagate inside Google.

- [ ] **Step 4: Push the implementation files to `main` and create the `staging` branch**

From local repo (after Tasks 1–3 are committed):

```bash
git push origin main
git checkout -b staging
git push -u origin staging
```

Pushing `staging` for the first time will fire the `deploy-staging.yml` workflow — but it will fail until step 7 is complete. That is expected; the failed run can be retried via `workflow_dispatch` after secrets are set.

- [ ] **Step 5: Create `/opt/claude-server-staging` on the VPS**

SSH into the VPS as root:

```bash
git clone https://github.com/trannam110702/claude-server.git /opt/claude-server-staging
cd /opt/claude-server-staging
git checkout staging
```

- [ ] **Step 6: Generate a fresh `AUTH_SECRET` for staging**

On any machine with `openssl`:

```bash
openssl rand -base64 32
```

Copy the output. This will become staging's `AUTH_SECRET` and **must differ from prod's** so session cookies don't cross environments.

- [ ] **Step 7: Create the `VPS_ENV_STAGING` GitHub secret**

Go to https://github.com/trannam110702/claude-server/settings/secrets/actions. Click **New repository secret**. Name: `VPS_ENV_STAGING`. Value: a copy of the prod `.env` with these substitutions:

- `AUTH_URL=https://falconclaudestaging.duckdns.org`
- `AUTH_SECRET=<the value generated in step 6>`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — keep the same as prod
- `OAUTH_ACCESS_TOKEN` / `OAUTH_REFRESH_TOKEN` — leave blank (staging will get its own Claude account)
- `ADMIN_EMAILS` — same as prod (so you can sign in as admin on staging)
- All other variables — copy verbatim from prod

Save the secret.

- [ ] **Step 8: Re-run the workflow**

Go to https://github.com/trannam110702/claude-server/actions, find the most recent **Deploy (staging)** run (probably failed), and click **Re-run all jobs**. (Or push an empty commit to `staging`: `git commit --allow-empty -m "ci: trigger staging deploy" && git push`.)

Expected: workflow succeeds. On the VPS, `docker ps` shows `claude-server-staging` running and listening on `0.0.0.0:8081`.

---

## Task 5: First-deploy verification

These steps confirm the staging environment is reachable end-to-end. Run after Task 4 step 8 succeeds.

- [ ] **Step 1: Verify the container is healthy on the VPS**

SSH into the VPS:

```bash
docker ps --filter name=claude-server-staging
docker logs --tail 50 claude-server-staging
curl -fsS http://127.0.0.1:8081/health
```

Expected: container shown as `Up`, logs show `Claude proxy server running at http://0.0.0.0:8080`, and `/health` returns `{"status":"ok","auth":"oauth","accounts":0}`.

- [ ] **Step 2: Verify the public hostname serves the dashboard**

From any machine:

```bash
curl -I https://falconclaudestaging.duckdns.org
```

Expected: HTTP `302 Found` redirecting to `/dashboard` (this is the root-level redirect in `index.js`).

Then visit https://falconclaudestaging.duckdns.org in a browser. You should land on the staging dashboard (visually identical to prod). Sign in with Google — staging will create a fresh user record (or reuse one if Task 6 has been run).

- [ ] **Step 3: (Optional) Seed staging from prod**

If you want staging to start with prod's users + analytics, SSH into the VPS and run:

```bash
cd /opt/claude-server-staging
./scripts/bootstrap-staging-from-prod.sh
```

Expected output: ends with `staging seeded from prod, accounts cleared.` Then `accounts row count` line should print `0`.

- [ ] **Step 4: Add a Claude account on staging**

Visit https://falconclaudestaging.duckdns.org/dashboard/accounts and click **Add Account**. Complete the Claude OAuth flow. The account is saved to staging's `claude-data-staging` volume only — prod's `accounts` table is untouched.

- [ ] **Step 5: Smoke-test the proxy endpoint on staging**

From any machine, with a user-issued bearer token created on staging:

```bash
curl -fsS https://falconclaudestaging.duckdns.org/v1/messages \
  -H "Authorization: Bearer <staging-token>" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}'
```

Expected: a normal Claude response. If the request fails with `503`/`502`, check `docker logs claude-server-staging` and Caddy logs.

- [ ] **Step 6: Confirm the promotion path works**

Make a trivial change locally (e.g., a comment), commit to `staging`, push:

```bash
git checkout staging
# make a small edit
git commit -am "test: verify staging deploy pipeline"
git push
```

Watch the Actions tab for the **Deploy (staging)** run to complete. Confirm `docker ps` on the VPS shows the staging container restarted recently.

Then promote to prod:

```bash
git checkout main
git merge staging
git push
```

Watch the **Deploy** run, confirm prod restarts. The two pipelines are independent — neither blocks the other.

---

## Notes

- **Where new code goes after this plan.** All future feature work follows the flow: branch off `main`, develop locally, merge into `staging` to test on `falconclaudestaging.duckdns.org`, then merge `staging → main` to ship.
- **Schema migrations.** Each env owns its own `usage.db`. A migration that runs on container start hits staging first (good — that is the point); the same migration runs against prod's DB on the next prod deploy. If a migration is destructive, the bootstrap script lets you reset staging from prod between iterations.
- **Disk usage.** Two checkouts + two image variants ≈ 1–2 GB extra. The single-image-cache means staging builds reuse prod's layers, so subsequent staging deploys are quick.
- **Resource isolation.** Both containers run under the same Docker engine without resource limits. If staging load tests start to affect prod, add `mem_limit` / `cpus` to the staging override.
