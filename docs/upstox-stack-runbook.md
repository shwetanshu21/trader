# Upstox stack recovery runbook

This repo now has a notifier-backed local MCP bridge for Upstox. The moving pieces are:

1. `upstox-notifier` on `127.0.0.1:8788`
2. `upstox-mcp-local` on `127.0.0.1:8787`
3. `localtunnel` / `loca.lt` public webhook
4. `trader-upstox-runtime` on `127.0.0.1:3001`

## Fast path

From the repo root:

```bash
bash scripts/start-upstox-stack.sh --request-token
```

That will:
- start the notifier
- start the local MCP bridge
- start the `loca.lt` tunnel
- print the public notifier URL
- trigger a fresh Upstox token request

Then:
1. update the Upstox app's notifier URL if needed
2. approve the token request in Upstox / WhatsApp
3. bring the runtime up:

```bash
bash scripts/start-upstox-stack.sh --await-token --start-runtime
```

## One-command verification

```bash
bash scripts/verify-upstox-bridge.sh
```

This verifies:
- TypeScript build
- bridge-focused tests
- notifier token witness
- notifier health
- MCP bridge health
- runtime broker health
- bridge success witness

## Useful direct checks

### Token file

```bash
node --import tsx scripts/check-upstox-token.ts
```

Expected success shape includes:
- `"exists": true`
- `"messageType": "access_token"`

### Request a fresh token

```bash
node --import tsx scripts/request-upstox-access-token.ts
```

Expected success shape includes:
- `"status": 200`
- a `notifier_url`

### Notifier health

```bash
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/last-delivery
```

### Bridge health

```bash
curl http://127.0.0.1:8787/health
```

Look for:
- `bridge.token.exists: true`
- recent `get-full-market-quote` success
- `lastFailure: null`

### Runtime health

```bash
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3001/dashboard
```

Healthy broker path should show:
- `"verdict": "healthy"`
- `"state": "connected"`
- `"isStale": false`

## Common failure modes

### 1. Approved token request but no token file arrives

Likely cause:
- the public `loca.lt` tunnel is dead or changed

Check:
- the tunnel URL printed by `scripts/start-upstox-stack.sh`
- that Upstox app config uses the same URL
- `curl http://127.0.0.1:8788/last-delivery`

### 2. Runtime starts but broker stays degraded

Check in order:
1. `node --import tsx scripts/check-upstox-token.ts`
2. `curl http://127.0.0.1:8787/health`
3. `curl http://127.0.0.1:3001/health`

If bridge token exists but quote calls are failing, inspect:
- `tmp/upstox/logs/bridge.log`
- `tmp/upstox/mcp-local/status.json`

### 3. Upstox rejects a webhook URL

Observed behavior:
- some domains are rejected by policy
- `loca.lt` was accepted where ngrok was not

Prefer `loca.lt` for notifier URL updates.

## Local log paths

- `tmp/upstox/logs/notifier.log`
- `tmp/upstox/logs/bridge.log`
- `tmp/upstox/logs/tunnel.log`
- `tmp/upstox/logs/runtime.log`

## Status / pid paths

- `tmp/upstox/runtime/*.pid`
- `tmp/upstox/mcp-local/status.json`
- `tmp/upstox/notifier/latest-token.json`
