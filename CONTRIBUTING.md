# Contributing to mcpdd

## Running Locally

```bash
git clone https://github.com/AugmentedMCP/mcpdd.git
cd mcpdd
npm install
npm start
```

The dashboard is at [http://localhost:3000](http://localhost:3000). The app uses bundled seed data and starts probing MCP servers immediately.

## How Ingest Works

`ingest.js` fetches all servers from the official [MCP Registry](https://registry.modelcontextprotocol.io), applies a filter pipeline (version dedup, junk detection, bad URL filtering, transport dedup), and writes the result to `data/servers.json`.

To refresh from the registry:

```bash
npm run ingest
```

For development, use the cached registry data to avoid hammering the registry:

```bash
node ingest.js --from-cache
```

The `--from-cache` flag re-processes from `data/registry-cache.json` (created by a previous full run) with no network requests.

## Code Style

- ES modules (`import`/`export`), no CommonJS
- No build step, no TypeScript — plain JavaScript
- Vanilla JS frontend (no framework), single `public/index.html` SPA
- Node 20+

## What's Welcome

- Bug fixes and reliability improvements
- Better junk/spam server detection in the ingest pipeline
- Dashboard UX improvements
- New probe diagnostics or health signals
- Documentation improvements

## Submitting Changes

1. Fork the repo and create a feature branch
2. Make your changes
3. Test locally: `npm start` and verify the dashboard works
4. Open a pull request with a clear description of what changed and why

For larger changes, open an issue first to discuss the approach.
