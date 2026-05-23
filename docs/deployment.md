# Trader Deployment Guide

This document describes how the trader stack is deployed across cloud providers.

## Environments

| Environment | Provider | IP | User | Path | Status |
|-------------|----------|-----|------|------|--------|
| Primary | OVHcloud | `149.202.214.140` | `ubuntu` | `/home/ubuntu/trader` | Active |
| Standby | Hetzner | `178.104.167.248` | `root` | `/root/trader` | Active (IP only) |

Both environments use the same SSH deploy key: `hetzner_deploy`.

## Architecture

The stack consists of four systemd-managed Node.js services:

1. `trader-upstox-notifier.service` — Upstox webhook notifier on port `8788`
2. `trader-upstox-mcp-local.service` — Upstox MCP bridge on port `8787`
3. `trader.service` — Main trading runtime on port `3001`
4. `trader-operator-ui.service` — Operator dashboard on port `3100`

### OVHcloud (Primary)

- Reverse proxy: **Caddy** routes `details.aeroinference.com`
  - `/upstox/*` → `127.0.0.1:8788`
  - `/runtime/*` → `127.0.0.1:3001` (with basic auth)
  - everything else → `127.0.0.1:3100`
- Services run as `ubuntu` under `/home/ubuntu/trader`
- Current revision tracked in `/home/ubuntu/trader/DEPLOYED-REVISION.txt`

### Hetzner (Secondary / Standby)

- Reverse proxy: **Caddy** (currently offline; accessible directly by IP `178.104.167.248`)
- Services run as `root` under `/root/trader`
- Current revision tracked in `/root/trader/DEPLOYED-REVISION.txt`

## Deployment Procedure

Prerequisites:
- Target server has Node.js ≥ 22 (`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`)
- Target server has `git`
- SSH access with the `hetzner_deploy` key

### 1. Clone

```bash
ssh -i ~/.ssh/hetzner_deploy <user>@<ip>
git clone https://github.com/shwetanshu21/trader.git trader
cd trader
npm ci
```

### 2. Environment

Copy `.env` and `.env.deploy-secrets` from the primary environment:

```bash
scp -i ~/.ssh/hetzner_deploy root@178.104.167.248:/root/trader/.env <user>@<ip>:<path>/.env
scp -i ~/.ssh/hetzner_deploy root@178.104.167.248:/root/trader/.env.deploy-secrets <user>@<ip>:<path>/.env.deploy-secrets
```

Ensure required directories exist:

```bash
mkdir -p data tmp/upstox/notifier
```

### 3. Systemd Services

Install the unit files from `config/systemd/` to `/etc/systemd/system/`, adapting paths and the `User`/`Group` fields for the target host:

| File | Changes per host |
|------|-----------------|
| `trader-upstox-notifier.service` | `User`, `Group`, `WorkingDirectory`, `EnvironmentFile`, `ReadWritePaths` |
| `trader-upstox-mcp-local.service` | same fields |
| `trader.service` | same fields |
| `trader-operator-ui.service` | same fields |

Then reload and enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now trader-upstox-notifier.service \
  trader-upstox-mcp-local.service \
  trader.service \
  trader-operator-ui.service
```

### 4. Verify

Check all services:

```bash
sudo systemctl status trader-upstox-notifier.service \
  trader-upstox-mcp-local.service \
  trader.service \
  trader-operator-ui.service
```

Health endpoints (run on the host):

```bash
curl http://127.0.0.1:8788/health   # notifier
curl http://127.0.0.1:8787/health   # mcp bridge
curl http://127.0.0.1:3001/health   # runtime
curl http://127.0.0.1:3100/health   # operator ui
```

### 5. Caddy (optional — if external access needed)

Install Caddy and configure the Caddyfile:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

Create `/etc/caddy/Caddyfile` (replace `details.aeroinference.com` with your domain):

```caddy
details.aeroinference.com {
    handle /upstox/* {
        reverse_proxy 127.0.0.1:8788
    }

    redir /runtime /runtime/dashboard 302

    handle_path /runtime/* {
        basicauth {
            shwetanshu21 $2a$14$xBjsp.JsR1bH3NMd1GsTy.iW4kdNOXo1My5i8Z9fhY3tt5AOkK7uG
        }
        reverse_proxy 127.0.0.1:3001
    }

    handle {
        reverse_proxy 127.0.0.1:3100
    }
}
```

Then reload:

```bash
sudo systemctl restart caddy
```

**Firewall note:** OVH instances often have UFW active with only SSH open. If Caddy fails to obtain a Let's Encrypt certificate with "Timeout during connect (likely firewall problem)", open ports 80 and 443:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

### 6. Track Revision

```bash
git rev-parse HEAD > DEPLOYED-REVISION.txt
echo origin $(git remote get-url origin) >> DEPLOYED-REVISION.txt
```

## Post-Deployment Notes

- The runtime will start in a **degraded** state until a valid Upstox token is obtained. This is expected.
- To obtain a token on a fresh host with Caddy (no tunnel needed):
  1. Ensure Caddy is running and the notifier URL (`https://<domain>/upstox/notifier`) is reachable
  2. Update the Upstox developer dashboard to use that notifier URL
  3. Run the token request:
     ```bash
     cd /home/ubuntu/trader
     UPSTOX_NOTIFIER_URL=https://details.aeroinference.com/upstox/notifier \
       node --import tsx scripts/request-upstox-access-token.ts
     ```
  4. Approve the request in Upstox / WhatsApp
  5. Verify: `node --import tsx scripts/check-upstox-token.ts`
- Both deployments use Caddy for TLS termination and external routing. OVH serves `details.aeroinference.com`; Hetzner is accessible directly by IP.
- Both deployments use `NODE_ENV=production` and `TRADER_SCHEDULER_INTERVAL_MS=60000`.

## Service Logs

```bash
journalctl -u trader.service -f
journalctl -u trader-upstox-mcp-local.service -f
journalctl -u trader-upstox-notifier.service -f
journalctl -u trader-operator-ui.service -f
```
