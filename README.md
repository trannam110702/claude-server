# Claude Server - OAuth Proxy

A lightweight proxy server that forwards requests to **Claude (Anthropic)** using OAuth 2.0 with PKCE flow.
Supports both **native Claude format** (`/v1/messages`) and **OpenAI-compatible format** (`/v1/chat/completions`).

## How It Works

```
Your App  -->  Claude Server (proxy)  -->  Claude API
                  |
                  |- Auto-refreshes OAuth tokens
                  |- Translates OpenAI format to Claude format
                  |- Fallback across multiple accounts
```

1. You provide OAuth tokens (access + refresh) to the server.
2. When your app sends a request, the server checks token validity.
3. If expired, it automatically refreshes using the refresh token.
4. The request is forwarded to Claude's API with a valid token.
5. Background refresh runs every 30 minutes to keep tokens alive.

## VPS Setup (Docker Only)

You only need Docker installed on your VPS. No need to clone the repo.

### Step 1: Get Your OAuth Tokens

You need an **Access Token** and **Refresh Token** from Claude. There are two ways:

**Option A:** Clone the repo temporarily on a machine with a browser:
```bash
git clone https://github.com/nam1107/claude-server.git /tmp/claude-login
cd /tmp/claude-login && npm install && npm run login
```
After login, copy the tokens from the generated `tokens.json`.

**Option B:** If you already have tokens (e.g. from Claude Code), skip to Step 2.

Your tokens look like:
- Access Token: `sk-ant-oat01-...`
- Refresh Token: `sk-ant-ort01-...`

### Step 2: Create the tokens file on your VPS

SSH into your VPS and create the tokens file:

```bash
mkdir -p /data/claude-server

cat > /data/claude-server/tokens.json << 'EOF'
{
  "accessToken": "sk-ant-oat01-YOUR_ACCESS_TOKEN_HERE",
  "refreshToken": "sk-ant-ort01-YOUR_REFRESH_TOKEN_HERE",
  "expiresAt": "2025-01-01T00:00:00.000Z"
}
EOF

chmod 600 /data/claude-server/tokens.json
```

> Set `expiresAt` to a past date to force an immediate refresh on startup.

### Step 3: Run with Docker

```bash
docker run -d \
  --name claude-server \
  --restart unless-stopped \
  -p 8080:8080 \
  -e HOST=0.0.0.0 \
  -v /data/claude-server/tokens.json:/app/tokens.json \
  nam1107/claude-server
```

### Step 4: Verify

```bash
# Health check
curl http://localhost:8080/health

# Check logs
docker logs -f claude-server
```

## Multi-Account Fallback (Optional)

To use multiple Claude accounts for failover, create an `accounts.json` file:

```bash
cat > /data/claude-server/accounts.json << 'EOF'
[
  {
    "accessToken": "sk-ant-oat01-ACCOUNT_1_TOKEN",
    "refreshToken": "sk-ant-ort01-ACCOUNT_1_REFRESH",
    "expiresAt": "2025-01-01T00:00:00.000Z"
  },
  {
    "accessToken": "sk-ant-oat01-ACCOUNT_2_TOKEN",
    "refreshToken": "sk-ant-ort01-ACCOUNT_2_REFRESH",
    "expiresAt": "2025-01-01T00:00:00.000Z"
  }
]
EOF
```

Then mount it alongside the tokens file:

```bash
docker run -d \
  --name claude-server \
  --restart unless-stopped \
  -p 8080:8080 \
  -e HOST=0.0.0.0 \
  -v /data/claude-server/tokens.json:/app/tokens.json \
  -v /data/claude-server/accounts.json:/app/accounts.json \
  nam1107/claude-server
```

## Token Binding (Important)

Claude OAuth tokens may be bound to the IP address where they were created. If tokens from your Mac don't work on the VPS, you need to generate them from the VPS IP.

**Use SSH port forwarding:**

```bash
# On your Mac — forward port 9999 from VPS to your local machine
ssh -L 9999:localhost:9999 root@YOUR_VPS_IP
```

Then inside the SSH session, run a temporary container to do the login:

```bash
docker run -it --rm \
  -p 9999:9999 \
  -e OAUTH_CALLBACK_PORT=9999 \
  -v /data/claude-server/tokens.json:/app/tokens.json \
  nam1107/claude-server \
  node index.js login
```

Copy the authorization URL, open it in **your Mac's browser**, and complete the login. The tokens will be saved to `/data/claude-server/tokens.json` on the VPS.

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/v1/messages` | POST | Claude native format (pass-through) |
| `/v1/chat/completions` | POST | OpenAI-compatible format (auto-translated) |
| `/health` | GET | Health check + account status |

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `HOST` | Bind address | `127.0.0.1` |
| `PORT` | Server port | `8080` |
| `OAUTH_CALLBACK_PORT` | Fixed port for login callback | random |
| `ANTHROPIC_BASE_URL` | Custom Anthropic API base URL | `https://api.anthropic.com` |

## Common Docker Commands

```bash
# View logs
docker logs -f claude-server

# Restart
docker restart claude-server

# Stop and remove
docker stop claude-server && docker rm claude-server

# Update to latest image
docker pull nam1107/claude-server
docker stop claude-server && docker rm claude-server
# Then re-run the docker run command from Step 3
```

## Troubleshooting

**"No credentials found"**
- Check that `tokens.json` is mounted correctly and contains valid tokens.

**"Refresh token not found or invalid"**
- Re-generate tokens from the VPS IP using the SSH port forwarding method above.

**Cannot connect to port 8080**
- Ensure `HOST=0.0.0.0` is set and the firewall allows port 8080:
  ```bash
  ufw allow 8080
  ```

**Tokens not persisting after container restart**
- Ensure the volume mount points to a file, not a directory:
  `-v /data/claude-server/tokens.json:/app/tokens.json`

## Security

- Protect your tokens file: `chmod 600 /data/claude-server/tokens.json`
- The server only proxies requests — it does not log or store conversation content.
- Consider putting the server behind a reverse proxy (nginx/caddy) with HTTPS for production use.
