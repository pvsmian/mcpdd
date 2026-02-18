# MCP Downdetector (mcpdd) - Discussion Notes

## Concept
A service + dashboard that tracks the health/uptime of MCP servers in the ecosystem.
- **For humans**: a web dashboard (think downdetector.com but for MCP servers)
- **For AI**: an MCP server that exposes health data (meta!)
- **Server list**: auto-populated from the official MCP registry at
  https://github.com/modelcontextprotocol/registry
- **Separate project** from PhoneMCP — mcpdd is a neutral ecosystem tool that would
  track PhoneMCP alongside all other servers.

## Decisions Made
1. Working title: **mcpdd** (MCP Downdetector)
2. Two interfaces: human dashboard + MCP server for AI consumers
3. Source of truth for server list: official MCP registry (auto-sync)
4. This is a standalone project, not a feature of PhoneMCP
5. Domain: **mcpdd.org** (Route 53)
6. Open source from day one
7. Hosting: AWS (Route 53 already in use)
8. v1 scope: **remote servers only** (streamable-http / SSE) — no stdio
9. Health and auth are **two independent axes** — protected (🔒) is not a health state,
   it's shown as a separate icon alongside the health indicator

## Open Questions
- ~~What does "health" mean?~~ → DECIDED (see Health Check Design)
- ~~stdio vs remote?~~ → DECIDED: remote only for v1
- ~~How often do we poll?~~ → DECIDED: every 60 seconds
- ~~Do we track latency, uptime %, incident history?~~ → DECIDED: yes, all three (see Implementation)
- ~~What's the tech stack?~~ → DECIDED: Node.js + Express, single process (see Implementation)
- ~~Auth handling?~~ → DECIDED: auth is a separate axis, 401 = alive + protected
- ~~How do we discover the live server list?~~ → DECIDED: MCP registry v0.1 API (see Registry API)
- ~~Community reporting vs. automated-only?~~ → DECIDED: automated-only for MVP
- Do we expose historical data beyond 24h? (7d, 30d?)
- Alerting / notifications? (RSS, webhooks, email?)
- MCP server interface (for AI consumers) — not yet built
- Auto-sync server list from registry (currently manual in servers.json)
- Per-service OAuth to do deeper checks on protected servers — **not feasible** for MVP;
  each service (Stripe, Notion, etc.) has its own OAuth provider, no universal auth

## Key Gaps (remaining)
- **stdio servers can't be probed remotely**: Most MCP servers are distributed as npm/pypi
  packages that run locally via `npx`/`uvx`. Health-checking these would mean actually
  installing and running them, which is heavy and may require API keys.
- **Auth-gated servers**: Each service has its own OAuth/API key provider. We can't
  do deeper checks (ping, tools/list) without per-service credentials. A Google Sign-in
  on mcpdd wouldn't help — Stripe wants a Stripe token, not a Google token.
- **Auto-sync from registry**: Currently servers are manually listed in `servers.json`.
  Should eventually auto-discover from the registry API.

## MCP Registry - Key Facts
- Server entries are **JSON** (`server.json` format), validated against a JSON Schema
- Naming: reverse-DNS style (e.g., `airtable/airtable-mcp-server`)
- Each server can have:
  - `packages[]` — installable packages (npm, pypi, oci, nuget, mcpb) using stdio transport
  - `remotes[]` — remote endpoints (streamable-http or SSE) with URLs
- Key fields: name, description, version, repository, websiteUrl, packages, remotes
- Env vars / arguments are declared per-package (including `isSecret` flag)
- Seed data has only 4 entries; real catalog is served by the live registry API

## Health Check Design

### Scope: Remote servers only (streamable-http / SSE)
stdio servers are local processes — can't be probed remotely. Any MCP server that
becomes important will likely go remote. stdio may be revisited later (package registry
checks, repo activity) but is out of scope for v1.

### Two independent axes

**Axis 1: Health** (how well is the server functioning?)
| State | Color | Meaning |
|-------|-------|---------|
| 🟢 Healthy | Green | Server responds, MCP handshake + tools/list succeed |
| 🟡 Degraded | Yellow | Server responds but latency exceeds threshold |
| 🟠 Unhealthy | Orange | Server reachable but MCP layer broken (bad JSON-RPC, initialize fails) |
| 🔴 Down | Red | Server unreachable (timeout, DNS failure, HTTP 5xx) |

**Axis 2: Auth** (separate indicator, adjacent to health)
| State | Icon | Meaning |
|-------|------|---------|
| 🔓 Open | Unlocked | No auth required — full probe depth possible |
| 🔒 Protected | Locked | Auth required — probe goes as far as it can |

These are **independent**. A protected server can be 🟢+🔒 (healthy as far as we can
tell) or 🔴+🔒 (down and also requires auth). Protected is not a health state — it's
a property of the server.

### Probe sequence (per check cycle)

```
1. POST initialize request to server URL
   ├── Timeout / connection refused  →  🔴 DOWN
   ├── HTTP 401/403                  →  🔒 PROTECTED + 🟢 HEALTHY (server is alive, responded correctly)
   ├── HTTP 5xx                      →  🔴 DOWN
   ├── HTTP 200 + invalid JSON-RPC   →  🟠 UNHEALTHY
   └── HTTP 200 + valid InitializeResult → continue...

2. Send ping (measure latency)
   ├── No response / timeout         →  🟡 DEGRADED
   └── Empty {} response             →  record latency, continue...

3. Call tools/list
   ├── JSON-RPC error                →  🟠 UNHEALTHY
   └── Success                       →  🟢 HEALTHY + 🔓 OPEN
                                        cache schema, compare to previous
```

### Latency thresholds (configurable)
- < 500ms → healthy
- 500ms–2s → degraded
- > 2s or no response → degraded/down

### MCP spec facts (verified against spec rev 2025-03-26)
- `ping` is a real MCP method — request `{"method":"ping"}`, response `{"result":{}}`
- `initialize` is mandatory first interaction — returns server name, version, capabilities
- `tools/list` returns tool definitions with JSON Schema for inputs
- Streamable HTTP: single endpoint, POST for messages, `Mcp-Session-Id` header for sessions
- HTTP 404 from server = session terminated (not necessarily server down)
- JSON-RPC error codes: -32700 (parse), -32600 (invalid request), -32601 (method not found),
  -32602 (invalid params), -32603 (internal error)

### Schema caching
- When a server is open, cache `tools/list` response
- If it later goes protected or offline, show "last known tools"
- Track schema diffs — notify when tools change (breaking change detection)

## Feature Ideas (from Gemini convo)
- Real-time latency tracking ("time to tool result")
- User incident reports (classic downdetector community signal)
- Schema diff tracking (detect breaking tool changes)
- Regional health (probe from multiple locations)
- "Probe" MCP server — agents can ask "is X down?"
- Public schema caching (show last-known tools even when server is down/protected)

## MCP Registry API

The official MCP registry at `registry.modelcontextprotocol.io` provides:

- **Search**: `GET /v0.1/servers?search={query}&limit=N`
- **Detail**: `GET /v0.1/servers/{name}/versions/{version}`
  - `{name}` is URL-encoded, e.g. `com.stripe%2Fmcp`
  - Returns JSON with server metadata, remotes, repository URL

Each server has a registry name like `com.stripe/mcp` or `com.phone-mcp/phonemcp-mcp-server`.
We store `registryName` + `registryVersion` in `servers.json` and construct the detail URL
for the info link icon on the dashboard.

**Important**: search by exact registry name (e.g. `com.microsoft/microsoft-learn-mcp`),
not by keyword (e.g. `microsoft learn`). Keyword search often misses results.

## Implementation (current state)

### Architecture
Single Node.js process: `node server.js`
- **Probes** MCP servers every 60s using `@modelcontextprotocol/sdk`
- **Stores** check history in memory (persisted to `data/history.json`)
- **Serves** dashboard HTML + `/api/status` JSON endpoint via Express
- Dashboard fetches `/api/status` every 15s and re-renders

### Tech stack
- Node.js + Express (single process, no build step)
- `@modelcontextprotocol/sdk` for MCP protocol (Client, StreamableHTTPClientTransport, SSEClientTransport)
- `zod` (SDK peer dep)
- No database — in-memory + JSON file persistence
- No TypeScript — plain ESM JS

### Files
```
package.json           — 3 deps: express, @modelcontextprotocol/sdk, zod
server.js              — Express + probe loop + persistence + /api/status
prober.js              — probeServer(config) → CheckResult
servers.json           — server configs with registry metadata
public/index.html      — dashboard (fetches live data, search, filter)
mockup.html            — original static mockup (reference)
data/history.json      — persisted check history (gitignored)
NOTES.md               — this file
```

### Servers monitored (11)
**Open (5):** Microsoft Learn, DeepWiki, Context7, Exa, MCP Registry
**Protected (6):** Stripe, Notion, Figma, Linear, Cloudflare, PhoneMCP

### Dashboard features
- Cards sorted worst-first (down → unhealthy → degraded → healthy)
- Each card shows: health dot, server name, info link (→ registry), lock icon if protected,
  latency, tool count (e.g. "3 tools"), uptime %, 24h status bar
- Sticky header with summary counts + "Last check Xs ago / Next in Ys"
- Auth filter (All / Open / Auth) — cycling button
- Find box with ↑↓ navigation, match counter, 3+ char activation

### API response shape (`GET /api/status`)
```json
{
  "lastCheck": "ISO timestamp",
  "nextCheck": "ISO timestamp",
  "servers": [{
    "id": "stripe",
    "name": "Stripe",
    "url": "https://mcp.stripe.com/",
    "infoUrl": "https://registry.modelcontextprotocol.io/v0.1/servers/com.stripe%2Fmcp/versions/0.2.4",
    "status": "healthy",
    "auth": "protected",
    "latencyMs": null,
    "toolCount": null,
    "uptimePercent": 100,
    "history": [{ "status": "healthy" }, ...]
  }]
}
```

## Domain
✅ **mcpdd.org** — registered on AWS Route 53

## Discussion Log

### Session 1 - 2026-02-14
- Established the core idea: health monitoring for MCP servers
- Two consumers: humans (dashboard) and AI (MCP server)
- Server list sourced from official MCP registry (auto-updated)
- Investigated registry structure — it's a Go app with an API, not a flat file of servers
- Identified the stdio vs. remote distinction as a key design challenge
- Reviewed prior Gemini conversation on same topic — incorporated ideas around
  tiered health checks, auth handling (401 = alive), schema caching/diffing,
  domain name options, and feature brainstorming
- Confirmed this is a separate project from PhoneMCP
- Registered **mcpdd.org** on Route 53
- Will be open source
- Discussed durability of idea — problem thesis (monitoring AI tool services) survives
  even if MCP protocol is replaced; architecture should keep probe layer pluggable
- Defined health check model: 4 health states (green/yellow/orange/red) + separate
  auth indicator (open/protected). Probe sequence: initialize → ping → tools/list.
  Verified against MCP spec rev 2025-03-26.
- Decided: v1 is remote servers only, no stdio

### Session 2 - 2026-02-15
- Built the mockup (mockup.html) — ~102 server cards with fake data
- Iterated layout: column alignment, sticky header, auth filter, find box
- Multiple UI refinements based on user feedback

### Session 3 - 2026-02-16
- Made the mockup functional — real MCP server probing
- Built prober.js using official SDK (StreamableHTTPClientTransport + SSEClientTransport)
- Discovered during testing: Semgrep and Parallel Search require auth (swapped for Context7, Exa)
- CORS blocks browser-side probing → need backend (Express)
- Built server.js with probe loop, in-memory history, JSON persistence, /api/status endpoint
- Connected frontend to live data — dashboard fetches /api/status every 15s
- Added info link icons next to server names — initially hand-picked URLs (inconsistent)
- User pointed out links were not uniform ("more like search results")
- Discovered MCP registry v0.1 API detail endpoint: `/v0.1/servers/{name}/versions/{version}`
- Key lesson: search by exact registry name, not keywords
- Standardized all info links to registry detail URLs (9/11 in registry, DeepWiki is not)
- Added tool count display ("3 tools") — already collected by prober, just wired to frontend
- Added PhoneMCP to server list (auth-protected, SSE)
- Discussed per-service OAuth for deeper checks — not feasible, each service has own OAuth provider
