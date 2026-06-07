# rbxasset-fetch

API server that fetches Roblox RBXM assets and parses them into JSON. Deployable as Express.js (Node.js) or Cloudflare Worker.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | API documentation |
| `GET /asset/:id` | Parse asset (nested JSON) |
| `GET /asset/:id/tree` | Parse asset (flat tree with paths) |
| `GET /asset/:id/search?class=X` | Search by class, property name, or property value |
| `GET /asset/:id/class/:className` | Get all instances of a class |
| `GET /asset/:id/raw` | Raw asset buffer (XML or base64) |
| `GET /health` | Health check |

## Query Parameters

| Param | Description |
|---|---|
| `ignoreClasses` | Comma-separated class names to exclude (e.g. `Folder,Script`) |
| `ignoreProperties` | Comma-separated property names to strip (e.g. `Source,Tags`) |

### Examples

```bash
# Fetch an asset
curl https://your-worker.dev/asset/6880366374

# Flat tree, ignoring Folders and Scripts
curl https://your-worker.dev/asset/6880366374/tree?ignoreClasses=Folder,Script

# Search for all Parts
curl https://your-worker.dev/asset/6880366374/search?class=Part

# Strip Source property from results
curl https://your-worker.dev/asset/6880366374?ignoreProperties=Source
```

## Authentication

Without auth, assets are fetched via RoProxy (public, no auth needed).

To use direct Roblox API access:

- **Cloudflare Worker:** Set `ROBLOX_COOKIE` env var
- **Express.js:** Set `ROBLOX_COOKIE` in `.env` or pass `X-Roblox-Cookie` header (requires `ALLOW_HEADER_COOKIE=true`)

## Deploy

### Cloudflare Worker

```bash
npx wrangler deploy
```

### Express.js (Node.js)

```bash
npm install
npm start
```

Server runs on `http://127.0.0.1:3000` by default (configurable via `PORT` and `HOST` env vars).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ROBLOX_COOKIE` | — | Roblox `.ROBLOSECURITY` cookie for authenticated access |
| `ALLOW_HEADER_COOKIE` | `false` | Allow cookie via `X-Roblox-Cookie` header |
| `ASSET_CACHE_TTL_MS` | `300000` | Cache TTL in milliseconds (5 min) |
| `PORT` | `3000` | Express server port |
| `HOST` | `127.0.0.1` | Express server bind address |
