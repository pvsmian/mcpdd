# mcpdd — MCP Down Detector

A status monitor for the [Model Context Protocol](https://modelcontextprotocol.io/) ecosystem. Tracks the health of remote MCP servers listed in the official MCP Registry.

Live at **[mcpdd.org](https://mcpdd.org)**

## Architecture

```
server.js        Express server, probe orchestration, REST API
prober.js        MCP SDK probe logic (initialize → ping → tools/list)
ingest.js        Registry ingestion (paginated fetch, filter, dedup, changelog)
public/          SPA dashboard with client-side routing
data/            Auto-generated configs + probe history (persistent)
```

Single Node.js process, no build step, no database. Probe history lives in memory and is persisted to `data/history.json`. Server configs are auto-ingested from the MCP Registry.

## Quick Start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The app boots with bundled seed data (`data/servers.json`) and begins probing immediately.

## Ingesting from the MCP Registry

Refresh the server list from the official registry:

```bash
npm run ingest           # fetch from registry, write data/servers.json + changelog
npm run ingest:dry       # fetch and filter, but don't write files
```

For offline development, use the cached registry data:

```bash
node ingest.js --from-cache
```

The server also runs ingest automatically on a 24-hour interval (configurable via `INGEST_INTERVAL_MS`, set to `0` to disable).

## Docker

```bash
docker compose up
```

Or build manually:

```bash
docker build -t mcpdd .
docker run -p 3000:3000 -v ./data:/app/data mcpdd
```

The `data/` volume persists probe history and server configs across restarts.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `PROBE_INTERVAL_MS` | `180000` | Probe cycle interval (ms) |
| `PROBE_TIMEOUT_MS` | `10000` | Per-server probe timeout (ms) |
| `INGEST_INTERVAL_MS` | `86400000` | Auto-ingest interval (ms), `0` to disable |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
