# OAuth Proxy Dashboard Design

## Overview

Add a Next.js dashboard to the Claude Server OAuth proxy, providing:
- Claude OAuth login/logout via browser UI
- Token usage / quota status tracking
- API request logs stored in SQLite
- Account health and refresh status

## Architecture

### Integration Model
- Next.js runs internally on port 3000
- Existing `index.js` on port 8080 proxies dashboard requests to Next.js
- Requests to `/dashboard/*` and `/api/*` (browser) → proxied to Next.js
- Requests to `/v1/*` → proxy traffic handled by existing logic

```
Browser → index.js:8080 → /dashboard/* → proxied to Next.js:3000
                        → /v1/* → proxy traffic (unchanged)
```

### Data Storage
- `data/tokens.json` — Claude OAuth tokens (existing)
- `data/usage.db` — SQLite database for request logs

### Tech Stack
- **Next.js** (App Router, TypeScript)
- **shadcn/ui** — Component library
- **better-sqlite3** — SQLite driver
- **Google OAuth** — Dashboard authentication (middleware)
- **Tailwind CSS** — Styling

---

## Dashboard Pages

### Dashboard Root (`/dashboard`)
- Main overview with summary cards
- Quick status: OAuth connected, token expiry, request count today

### OAuth Page (`/dashboard/oauth`)
- Login with Google button (triggers Google OAuth flow)
- Logout button
- Current session status: authenticated user email, login time
- Link to re-authenticate if token expired

### Usage Page (`/dashboard/usage`)
- Token usage / quota display
- Cards showing Claude API usage stats
- Auto-refresh every 60s with countdown
- Manual refresh button

### Logs Page (`/dashboard/logs`)
- Table columns: timestamp, method, endpoint, status, latency (ms), tokens used
- Filter by: date range, endpoint type, status code
- Pagination (50 rows per page)
- Export to CSV button

### Health Page (`/dashboard/health`)
- Token expiry countdown (days:hours:minutes)
- Last refresh timestamp
- Account status indicator (active/expired/expiring-soon)
- Manual token refresh button
- Next scheduled refresh time

---

## API Endpoints (Next.js API Routes)

### `GET /api/auth/session`
Returns current Google OAuth session status.

### `GET /api/auth/google`
Initiates Google OAuth flow.

### `GET /api/auth/google/callback`
Google OAuth callback handler.

### `POST /api/auth/logout`
Clears session cookie.

### `GET /api/claude/oauth`
Returns Claude OAuth token status (from `tokens.json`).

### `POST /api/claude/oauth/refresh`
Triggers manual token refresh.

### `GET /api/usage`
Returns token usage stats from Claude API.

### `GET /api/logs`
Query params: `page`, `limit`, `startDate`, `endDate`, `endpoint`
Returns paginated request logs from SQLite.

### `GET /api/health`
Returns token expiry, last refresh, account status.

### `GET /api/stats`
Returns aggregated stats: requests today, avg latency, error count.

---

## Request Logging

### SQLite Schema
```sql
CREATE TABLE request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER,
  latency_ms INTEGER,
  tokens_used INTEGER,
  model TEXT,
  error TEXT
);

CREATE INDEX idx_timestamp ON request_logs(timestamp);
CREATE INDEX idx_path ON request_logs(path);
```

### What Gets Logged
Every `/v1/messages` and `/v1/chat/completions` request:
- Timestamp (ISO 8601)
- HTTP method (POST)
- Request path
- Response status code
- Latency in milliseconds
- Token usage (if available from response)
- Model used
- Error message (if any)

---

## Authentication

### Google OAuth Flow
1. User visits `/dashboard/oauth`
2. Clicks "Login with Google"
3. Redirected to Google OAuth consent screen
4. After approval, redirected to `/api/auth/google/callback`
5. Session cookie set, user redirected to `/dashboard`

### Middleware Protection
- All `/dashboard/*` routes (except `/dashboard/oauth/login`) require valid session
- Session cookie checked in middleware
- Unauthorized → redirect to `/dashboard/oauth`

### Environment Variables
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
NEXTAUTH_SECRET=...
```

---

## File Structure

```
claude-server/
├── index.js                    # Existing proxy server
├── next-app/                   # Next.js dashboard
│   ├── app/
│   │   ├── (dashboard)/        # Protected routes
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx       # Overview
│   │   │   ├── oauth/
│   │   │   ├── usage/
│   │   │   ├── logs/
│   │   │   └── health/
│   │   ├── api/                # API routes
│   │   │   ├── auth/
│   │   │   ├── claude/
│   │   │   ├── usage/
│   │   │   ├── logs/
│   │   │   └── health/
│   │   ├── layout.tsx
│   │   └── globals.css
│   ├── components/
│   │   └── ui/                 # shadcn components
│   ├── lib/
│   │   ├── db.ts               # SQLite connection
│   │   ├── auth.ts             # Google OAuth helpers
│   │   └── ...
│   ├── middleware.ts           # Session protection
│   ├── package.json
│   └── ...
├── data/
│   └── usage.db                # SQLite database
├── docs/
│   └── specs/
│       └── 2026-04-29-dashboard-design.md
└── package.json                # Existing
```

---

## Implementation Order

1. Scaffold Next.js app with shadcn/ui
2. Set up SQLite database and request logging in `index.js`
3. Implement Google OAuth authentication
4. Build dashboard pages (OAuth, Usage, Logs, Health)
5. Wire up API routes
6. Test proxy integration
7. Commit

---

## Notes

- Claude OAuth tokens don't expose a direct usage API — usage tracking is per-request based
- Token refresh happens server-side every 30 minutes (existing logic)
- Google OAuth is for dashboard access only, separate from Claude OAuth
