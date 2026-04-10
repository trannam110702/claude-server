
# Claude Server – OAuth Proxy

A lightweight proxy server that forwards requests to **Claude (Anthropic)** using OAuth 2.0 with PKCE flow.
Supports both **native Claude format** (`/v1/messages`) and **OpenAI-compatible format** (`/v1/chat/completions`).

## How It Works (Flow Overview)

This server acts as a **proxy** between your application and Claude (Anthropic).

**Token Flow:**
1. You run `npm run login` (or `npm run setup`) → get **Access Token** + **Refresh Token** from Claude.
2. Tokens are saved to `tokens.json`.
3. When your app sends a request to this server (`/v1/messages` or `/v1/chat/completions`):
    - The server checks if the access token is still valid.
    - If expired or about to expire → automatically uses the refresh token to get a new access token.
    - The new tokens are saved back to `tokens.json`.
4. The server then forwards your request to Claude's official API with a valid token.
5. Response from Claude is returned to your application (with optional OpenAI format translation).

**Background Refresh:**
- Every 30 minutes, the server checks the token expiry.
- If the token will expire within 5 hours, it proactively refreshes it.
- This keeps the server running without manual intervention most of the time.
---

## Features
- Full OAuth PKCE login flow (browser-based)
- Manual token setup for headless/Docker environments
- Automatic access token refresh with background checks
- Tokens saved to `tokens.json` (portable across machines)
- Docker support with persistent volume
- No dependency on Claude Code keychain

## Quick Commands

After cloning the repository:

```bash
npm install
```

| Command                    | Description                                      |
|---------------------------|--------------------------------------------------|
| `npm run login`           | Full browser OAuth login (recommended)           |
| `npm run setup`           | Manual token input (for headless servers)        |
| `npm start`               | Start the server                                 |
| `npm run dev`             | Start with nodemon (auto-restart on changes)     |
| `npm run test:refresh`    | Test token refresh manually                      |
| `npm run docker:build`    | Build & push AMD64 Docker image                  |
| `npm run docker:run`      | Run Docker container with volume                 |
| `npm run docker:logs`     | Follow container logs in real-time               |
| `npm run docker:stop`     | Stop and remove all running containers           |

## Installation & Setup

### 1. Local Setup (Machine with Browser)

```bash
# Install dependencies
npm install

# Run OAuth login (browser will open automatically)
npm run login

# Start the server
npm start
```

The server will run at `http://127.0.0.1:8080`

### 2. Headless Server / VPS Setup

#### Option A: Manual Setup

```bash
npm run setup
```

You will be prompted to enter:
- Access Token (`sk-ant-oat01-...`)
- Refresh Token (`sk-ant-ort01-...`)

Or pass them directly:
```bash
npm run setup -- sk-ant-oat01-xxxx sk-ant-ort01-xxxx
```

#### Option B: Docker (Recommended for Production)

1. **On your local machine (Mac/Windows)** – Build the image:

```bash
npm run docker:build
```

2. **On the VPS (Contabo or any Linux server)**:

```bash
# Clean up old containers
npm run docker:stop

# Run the server with persistent tokens
docker run -d \
  -p 8080:8080 \
  -e HOST=0.0.0.0 \
  -v /data/tokens.json:/app/tokens.json \
  nam1107/claude-server
```

### 3. Important: Login from the Server's IP (Token Binding)

Claude OAuth tokens are often bound to the IP address. Tokens created on your Mac may not work on the VPS.

**Best method using SSH port forwarding:**

**On your Mac:**
```bash
ssh -L 9999:localhost:9999 root@161.97.150.95
```

**Inside the SSH session on the VPS:**
```bash
cd /path/to/claude-server          # or /tmp/claude-login
OAUTH_CALLBACK_PORT=9999 npm run login
```

- Copy the authorization URL shown in the terminal.
- Open it in **your Mac's browser**.
- After successful authorization, the `tokens.json` file will be created on the VPS.
- Then start the Docker container (see Option B above).

### 4. Verify the Server is Running

```bash
# Health check
curl http://YOUR_VPS_IP:8080/health

# View logs
npm run docker:logs
```

## Environment Variables

| Variable                  | Description                              | Default Value          |
|---------------------------|------------------------------------------|------------------------|
| `HOST`                    | Bind address                             | 127.0.0.1              |
| `PORT`                    | Server port                              | 8080                   |
| `OAUTH_CALLBACK_PORT`     | Fixed port for login callback            | random                 |
| `ANTHROPIC_BASE_URL`      | Custom Anthropic API base URL            | https://api.anthropic.com |

## Token Refresh

- The server automatically refreshes the access token before expiry.
- Background check runs **every 30 minutes**.
- New tokens are automatically saved to `tokens.json`.
- If refresh fails (`invalid_grant`), run `npm run login` again from the server's IP.

## Available Endpoints

- `POST /v1/messages` → Native Claude API format (pass-through)
- `POST /v1/chat/completions` → OpenAI-compatible format (auto-translated)
- `GET /health` → Health check

## Troubleshooting

**"Refresh token not found or invalid"**  
→ Run `npm run login` again from the same server/IP.

**Cannot connect to port 8080**  
→ Ensure `HOST=0.0.0.0` and open the firewall:
```bash
ufw allow 8080
```

**Port already in use during login**  
→ Try a different port:
```bash
OAUTH_CALLBACK_PORT=8888 npm run login
```

**Docker build error (platform)**  
→ Always use `npm run docker:build`

**Tokens not persisting after container restart**  
→ Make sure you use the volume mount: `-v /data/tokens.json:/app/tokens.json`

## Security Notes

- Never commit `tokens.json` to Git (already ignored).
- Protect `tokens.json` with proper permissions:
  ```bash
  chmod 600 /data/tokens.json
  ```
- The server only proxies requests, it does not log or store conversation content.

## Need Help?

If you get any error:
1. Run `npm run docker:logs` and copy the output.
2. Share the exact error message and which command you used.

---

**Done!**  
Just create a new file called `README.md` in the root of your project and paste the entire content above.

Would you like me to also create:
- A short `DEPLOYMENT.md` for VPS only?
- Or improve any part of this README?

Let me know!
