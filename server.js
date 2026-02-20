import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { probeServer } from './prober.js';
import { runIngest } from './ingest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const PROBE_INTERVAL_MS = parseInt(process.env.PROBE_INTERVAL_MS || '300000');
const INGEST_INTERVAL_MS = parseInt(process.env.INGEST_INTERVAL_MS || '86400000');
const PERSIST_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_PROBES = parseInt(process.env.MAX_CONCURRENT_PROBES || '15');
const DATA_DIR = join(__dirname, 'data');
const HISTORY_FILE = join(DATA_DIR, 'history.json');

// --- Load provider configs ---
function loadProviders() {
  const newPath = join(DATA_DIR, 'servers.json');
  const oldPath = join(__dirname, 'servers.json');

  if (existsSync(newPath)) {
    return JSON.parse(readFileSync(newPath, 'utf-8'));
  }
  // Fall back to legacy flat format, converting to new shape
  if (existsSync(oldPath)) {
    const legacy = JSON.parse(readFileSync(oldPath, 'utf-8'));
    return legacy.map(s => ({
      registryName: s.registryName || s.id,
      registryVersion: s.registryVersion || '0.0.0',
      displayName: s.name,
      sseOnly: s.transport === 'sse',
      remotes: [{ url: s.url, transport: s.transport || 'streamable-http', expectAuth: s.expectAuth || false, remoteName: 'default' }],
    }));
  }
  return [];
}

const providers = loadProviders();

// --- In-memory state ---
// History keyed by "registryName|url" (composite key per remote)
const history = new Map();
let lastCheckTime = null;
let nextCheckTime = null;
let probeInProgress = false;

// Initialize empty history for each remote
for (const provider of providers) {
  for (const remote of provider.remotes) {
    history.set(historyKey(provider.registryName, remote.url), []);
  }
}

function historyKey(registryName, url) {
  return `${registryName}|${url}`;
}

// --- Persistence ---
function loadHistory() {
  try {
    if (existsSync(HISTORY_FILE)) {
      const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
      const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
      for (const [key, checks] of Object.entries(data)) {
        if (history.has(key)) {
          history.set(key, checks.filter(c => c.timestamp > cutoff));
        }
      }
      console.log(`Loaded history from ${HISTORY_FILE}`);
    }
  } catch (err) {
    console.error(`Failed to load history: ${err.message}`);
  }
}

function persistHistory() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const obj = {};
    for (const [key, checks] of history) {
      obj[key] = checks;
    }
    writeFileSync(HISTORY_FILE, JSON.stringify(obj));
    console.log(`Persisted history to ${HISTORY_FILE}`);
  } catch (err) {
    console.error(`Failed to persist history: ${err.message}`);
  }
}

// --- Concurrency limiter ---
async function parallelLimit(tasks, limit) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  });
  await Promise.all(workers);
  return results;
}

// --- Fisher-Yates shuffle ---
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Probe all providers ---
let probeStartedAt = null;
let skipCount = 0;

async function probeAll() {
  if (probeInProgress) {
    skipCount++;
    const overrunSec = probeStartedAt ? Math.round((Date.now() - probeStartedAt) / 1000) : '?';
    console.log(`Probe already in progress (running ${overrunSec}s), skipping (${skipCount} consecutive skips)`);
    return;
  }
  probeInProgress = true;
  skipCount = 0;
  probeStartedAt = Date.now();
  const startTime = probeStartedAt;
  console.log(`\n--- Probe cycle starting at ${new Date().toISOString()} ---`);

  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;

  // Build tasks: one per provider
  const providerTasks = providers.map(provider => async () => {
    if (provider.remotes.length === 1) {
      // Single-remote: probe directly
      const remote = provider.remotes[0];
      const result = await probeRemote(provider, remote);
      recordResult(provider.registryName, remote.url, result, cutoff);
    } else {
      // Multi-remote: short-circuit probing
      await probeMultiRemote(provider, cutoff);
    }
  });

  await parallelLimit(providerTasks, MAX_CONCURRENT_PROBES);

  lastCheckTime = new Date().toISOString();
  nextCheckTime = new Date(Date.now() + PROBE_INTERVAL_MS).toISOString();
  probeInProgress = false;
  probeStartedAt = null;

  const elapsed = Date.now() - startTime;
  const totalRemotes = providers.reduce((s, p) => s + p.remotes.length, 0);
  const mem = process.memoryUsage();
  console.log(`--- Probe cycle complete in ${(elapsed / 1000).toFixed(1)}s (${providers.length} providers, ${totalRemotes} remotes) ---`);
  console.log(`    Memory: rss=${Math.round(mem.rss / 1048576)}MB heap=${Math.round(mem.heapUsed / 1048576)}/${Math.round(mem.heapTotal / 1048576)}MB`);
}

async function probeRemote(provider, remote) {
  return probeServer({
    url: remote.url,
    transport: remote.transport,
    expectAuth: remote.expectAuth,
  });
}

/**
 * Short-circuit probing for multi-remote providers.
 * Probe remotes sequentially in random order; stop after first red.
 */
async function probeMultiRemote(provider, cutoff) {
  const shuffled = shuffle(provider.remotes);
  let hitRed = false;

  for (const remote of shuffled) {
    if (hitRed) {
      // Short-circuit: mark remaining as unknown
      recordResult(provider.registryName, remote.url, {
        timestamp: Date.now(),
        status: 'unknown',
        auth: remote.expectAuth ? 'protected' : 'unknown',
        latencyMs: null,
        toolCount: null,
        error: 'short-circuited',
      }, cutoff);
      continue;
    }

    const result = await probeRemote(provider, remote);
    recordResult(provider.registryName, remote.url, result, cutoff);

    if (result.status === 'down') {
      hitRed = true;
    }
  }
}

function recordResult(registryName, url, result, cutoff) {
  const key = historyKey(registryName, url);
  const checks = history.get(key);
  if (!checks) return;

  checks.push(result);

  // Log
  const label = `${registryName.substring(0, 30)}`;
  console.log(
    `  ${label.padEnd(32)} ${result.status.padEnd(10)} auth=${(result.auth || '').padEnd(10)} ` +
    `latency=${result.latencyMs !== null ? result.latencyMs + 'ms' : '---'}` +
    (result.error ? ` err: ${result.error.substring(0, 50)}` : '')
  );

  // Trim old entries
  while (checks.length > 0 && checks[0].timestamp < cutoff) {
    checks.shift();
  }
}

// --- Full probe for a single provider (detail view, no short-circuit) ---
async function probeProviderFull(provider) {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  const results = await Promise.allSettled(
    provider.remotes.map(remote => probeRemote(provider, remote))
  );
  results.forEach((result, i) => {
    const remote = provider.remotes[i];
    if (result.status === 'fulfilled') {
      recordResult(provider.registryName, remote.url, result.value, cutoff);
    }
  });
}

// --- Status priority ---
const STATUS_PRIORITY = { down: 0, unhealthy: 1, degraded: 2, healthy: 3, unknown: 4 };

function worstStatus(statuses) {
  let worst = 'unknown';
  for (const s of statuses) {
    if ((STATUS_PRIORITY[s] ?? 4) < (STATUS_PRIORITY[worst] ?? 4)) {
      worst = s;
    }
  }
  return worst;
}

// --- Health icons algorithm ---
function computeHealthIcons(remoteStatuses) {
  const maxIcons = Math.min(3, remoteStatuses.length);
  if (maxIcons === 0) return [];

  // Map statuses to color categories
  const statusToColor = { healthy: 'green', degraded: 'yellow', unhealthy: 'orange', down: 'red', unknown: 'gray' };
  const colorPriority = { red: 0, orange: 1, yellow: 2, gray: 3, green: 4 };

  // Get distinct colors present
  const colorsPresent = [...new Set(remoteStatuses.map(s => statusToColor[s] || 'gray'))];
  colorsPresent.sort((a, b) => (colorPriority[a] ?? 4) - (colorPriority[b] ?? 4));

  // One icon per distinct color, fill remaining with worst color
  const icons = [];
  for (let i = 0; i < Math.min(colorsPresent.length, maxIcons); i++) {
    icons.push(colorsPresent[i]);
  }
  while (icons.length < maxIcons) {
    icons.push(colorsPresent[0]); // worst color
  }

  // Sort so worst is first (leftmost)
  icons.sort((a, b) => (colorPriority[a] ?? 4) - (colorPriority[b] ?? 4));

  return icons;
}

// --- Downsample to 24 hourly ticks ---
function downsampleToHours(checks) {
  const now = Date.now();
  const ticks = [];

  for (let i = 23; i >= 0; i--) {
    const hourStart = now - (i + 1) * 3600000;
    const hourEnd = now - i * 3600000;
    const inHour = checks.filter(c => c.timestamp >= hourStart && c.timestamp < hourEnd);

    if (inHour.length === 0) {
      ticks.push({ status: 'unknown' });
    } else {
      ticks.push({ status: worstStatus(inHour.map(c => c.status)) });
    }
  }

  return ticks;
}

// --- Build remote detail for API ---
function buildRemoteDetail(provider, remote) {
  const key = historyKey(provider.registryName, remote.url);
  const checks = history.get(key) || [];
  const latest = checks.length > 0 ? checks[checks.length - 1] : null;

  const totalChecks = checks.length;
  const nonDownChecks = checks.filter(c => c.status !== 'down').length;
  const uptimePercent = totalChecks > 0 ? Math.round((nonDownChecks / totalChecks) * 10000) / 100 : null;

  return {
    remoteName: remote.remoteName,
    url: remote.url,
    transport: remote.transport,
    status: latest ? latest.status : 'unknown',
    auth: latest ? latest.auth : (remote.expectAuth ? 'protected' : 'unknown'),
    latencyMs: latest ? latest.latencyMs : null,
    toolCount: latest ? latest.toolCount : null,
    uptimePercent,
    history: downsampleToHours(checks),
  };
}

// --- API: build provider-grouped status response ---
function buildStatusResponse() {
  const providerList = providers.map(provider => {
    const remoteDetails = provider.remotes.map(r => buildRemoteDetail(provider, r));
    const remoteStatuses = remoteDetails.map(r => r.status);
    const aggregate = worstStatus(remoteStatuses);

    // For the provider-level worst latency (from latest checks)
    const latencies = remoteDetails.map(r => r.latencyMs).filter(l => l !== null);
    const worstLatency = latencies.length > 0 ? Math.max(...latencies) : null;

    // Provider-level uptime: average of remote uptimes (where available)
    const uptimes = remoteDetails.map(r => r.uptimePercent).filter(u => u !== null);
    const avgUptime = uptimes.length > 0 ? Math.round((uptimes.reduce((a, b) => a + b, 0) / uptimes.length) * 100) / 100 : null;

    // Aggregate 24h history across all remotes (worst per hour)
    const aggregateHistory = [];
    for (let h = 0; h < 24; h++) {
      const hourStatuses = remoteDetails.map(r => r.history[h]?.status || 'unknown');
      aggregateHistory.push({ status: worstStatus(hourStatuses) });
    }

    return {
      registryName: provider.registryName,
      registryVersion: provider.registryVersion,
      displayName: provider.displayName,
      sseOnly: provider.sseOnly,
      aggregateStatus: aggregate,
      healthIcons: computeHealthIcons(remoteStatuses),
      remoteCount: provider.remotes.length,
      worstLatencyMs: worstLatency,
      uptimePercent: avgUptime,
      history: aggregateHistory,
      remotes: remoteDetails,
    };
  });

  return {
    lastCheck: lastCheckTime,
    nextCheck: nextCheckTime,
    providers: providerList,
  };
}

// --- Auto-ingest ---
async function doIngest() {
  console.log(`\n--- Ingest starting at ${new Date().toISOString()} ---`);
  try {
    const result = await runIngest();
    if (result) {
      console.log(`--- Ingest complete: ${result.providerCount} providers (+${result.added} -${result.removed} ~${result.changed}) ---`);
    } else {
      console.log('--- Ingest: no result (cache missing?) ---');
    }
  } catch (err) {
    console.error(`--- Ingest failed: ${err.message} ---`);
  }
}

// --- Express app ---
const app = express();
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

app.get('/api/status', (req, res) => {
  res.json(buildStatusResponse());
});

// Detail endpoint for a single provider
app.get('/api/server/:registryName', (req, res) => {
  const name = decodeURIComponent(req.params.registryName);
  const provider = providers.find(p => p.registryName === name);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });

  const remoteDetails = provider.remotes.map(r => buildRemoteDetail(provider, r));
  const remoteStatuses = remoteDetails.map(r => r.status);

  res.json({
    registryName: provider.registryName,
    registryVersion: provider.registryVersion,
    displayName: provider.displayName,
    sseOnly: provider.sseOnly,
    aggregateStatus: worstStatus(remoteStatuses),
    healthIcons: computeHealthIcons(remoteStatuses),
    remoteCount: provider.remotes.length,
    remotes: remoteDetails,
  });
});

// Trigger a full probe for a single provider (no short-circuit)
app.post('/api/server/:registryName/probe', async (req, res) => {
  const name = decodeURIComponent(req.params.registryName);
  const provider = providers.find(p => p.registryName === name);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });

  await probeProviderFull(provider);

  const remoteDetails = provider.remotes.map(r => buildRemoteDetail(provider, r));
  const remoteStatuses = remoteDetails.map(r => r.status);

  res.json({
    registryName: provider.registryName,
    displayName: provider.displayName,
    aggregateStatus: worstStatus(remoteStatuses),
    remotes: remoteDetails,
  });
});

// Changelog endpoint
app.get('/api/changelog', (req, res) => {
  const changelogFile = join(DATA_DIR, 'changelog.json');
  if (!existsSync(changelogFile)) return res.json([]);
  try {
    const data = JSON.parse(readFileSync(changelogFile, 'utf-8'));
    res.json(data);
  } catch {
    res.json([]);
  }
});

// SPA catch-all: serve index.html for client-side routes
app.get('/server/*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});
app.get('/changelog', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// --- Start ---
loadHistory();

const totalRemotes = providers.reduce((s, p) => s + p.remotes.length, 0);
app.listen(PORT, () => {
  console.log(`mcpdd running at http://localhost:${PORT}`);
  console.log(`Monitoring ${providers.length} providers (${totalRemotes} remotes), probe every ${PROBE_INTERVAL_MS / 1000}s`);

  probeAll();
  setInterval(probeAll, PROBE_INTERVAL_MS);
  setInterval(persistHistory, PERSIST_INTERVAL_MS);

  // Auto-ingest from MCP Registry
  if (INGEST_INTERVAL_MS > 0) {
    console.log(`Auto-ingest enabled: every ${INGEST_INTERVAL_MS / 1000}s (first run in 60s)`);
    setTimeout(async () => {
      await doIngest();
      setInterval(doIngest, INGEST_INTERVAL_MS);
    }, 60000);
  }
});

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  persistHistory();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
