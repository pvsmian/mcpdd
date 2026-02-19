# Deploying mcpdd on AWS Lightsail

Reference guide for the production instance. The app itself is cloud-agnostic — Lightsail is just a Linux VM.

## Instance Setup

1. Create a Lightsail instance ($3.50/mo, 512 MB RAM is sufficient)
   - OS: Amazon Linux 2023 or Ubuntu 22.04
   - Region: us-east-1 (or wherever is closest to most MCP servers)
2. Open ports: 80 (HTTP), 443 (HTTPS), 22 (SSH)
3. Attach a static IP

## Install Node.js

```bash
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc
fnm install 20
```

## Deploy the App

```bash
git clone https://github.com/AugmentedMCP/mcpdd.git /opt/mcpdd
cd /opt/mcpdd
npm ci --production
```

## Run with PM2

```bash
npm install -g pm2
pm2 start server.js --name mcpdd
pm2 save
pm2 startup
```

## TLS with Caddy

```bash
sudo dnf install caddy   # Amazon Linux
# or: sudo apt install caddy   # Ubuntu

sudo tee /etc/caddy/Caddyfile <<EOF
mcpdd.org {
    reverse_proxy localhost:3000
}
EOF

sudo systemctl enable caddy
sudo systemctl start caddy
```

Caddy automatically provisions and renews Let's Encrypt certificates.

## DNS

Point `mcpdd.org` A record to the Lightsail static IP (Route 53).

## Updates

```bash
cd /opt/mcpdd
git pull
npm ci --production
pm2 restart mcpdd
```
