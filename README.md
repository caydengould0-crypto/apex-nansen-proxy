# Apex Alpha — Nansen Proxy

Bridges Apex Alpha Research V2 (browser) → Nansen MCP server.

## Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Select the repo
4. Railway auto-detects Node.js and deploys
5. Copy your Railway URL (e.g. `https://apex-nansen-proxy.up.railway.app`)
6. Paste it into Apex Alpha V2 → ⚙ Providers → Nansen Proxy URL field

## How it works

Browser → Railway proxy → Nansen MCP → Railway proxy → Browser

The proxy handles the MCP protocol so the browser app can use simple REST calls.

## Endpoints

- `GET /ping` — test connection (requires NANSEN-API-KEY header)
- `GET /tools` — list available Nansen tools
- `GET /wallet/:address` — full wallet profile
- `GET /wallet/:address/positions` — open positions only
- `GET /smartmoney` — top smart money wallets
- `GET /token/:address/smartmoney` — smart money holders of a token

## Security

- API key passed per-request via header, never stored on server
- CORS enabled for browser access
- Research only — no trade execution
