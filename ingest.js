#!/usr/bin/env node
/**
 * ingest.js — Fetch all servers from the official MCP Registry,
 * filter/deduplicate, and write data/servers.json + data/changelog.json
 *
 * Usage:
 *   node ingest.js                # full run (fetches from registry)
 *   node ingest.js --dry-run      # fetch & filter but don't write files
 *   node ingest.js --from-cache   # re-process from local cache (no network)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const DATA_DIR = join(__dirname, 'data');
const SERVERS_FILE = join(DATA_DIR, 'servers.json');
const CHANGELOG_FILE = join(DATA_DIR, 'changelog.json');
const RAW_CACHE_FILE = join(DATA_DIR, 'registry-cache.json');
const PAGE_DELAY_MS = 200;
const MAX_AGE_DAYS = 90;
const DRY_RUN = process.argv.includes('--dry-run');
const FROM_CACHE = process.argv.includes('--from-cache');

// --- Fetch all pages from registry ---
async function fetchAllServers() {
  const allServers = [];
  let cursor = null;
  let page = 0;

  while (true) {
    const url = cursor
      ? `${REGISTRY_BASE}?cursor=${encodeURIComponent(cursor)}`
      : REGISTRY_BASE;

    page++;
    process.stdout.write(`  Page ${page}...`);

    const res = await fetchWithRetry(url, 3);
    if (!res.ok) throw new Error(`Registry API returned ${res.status}: ${await res.text()}`);

    const data = await res.json();
    const servers = data.servers || [];
    allServers.push(...servers);

    process.stdout.write(` ${servers.length} servers (total: ${allServers.length})\n`);

    const nextCursor = data.metadata?.nextCursor;
    if (!nextCursor || servers.length === 0) break;

    cursor = nextCursor;
    await delay(PAGE_DELAY_MS);
  }

  return allServers;
}

// --- Deduplicate by registryName, keeping only the latest version ---
function deduplicateVersions(rawServers) {
  const byName = new Map();
  for (const entry of rawServers) {
    const server = entry.server || entry;
    const meta = entry._meta?.['io.modelcontextprotocol.registry/official'] || {};
    const name = server.name || '';

    if (!byName.has(name)) {
      byName.set(name, entry);
    } else {
      const existing = byName.get(name);
      const existingMeta = existing._meta?.['io.modelcontextprotocol.registry/official'] || {};

      if (meta.isLatest && !existingMeta.isLatest) {
        byName.set(name, entry);
      } else if (!existingMeta.isLatest && meta.publishedAt && existingMeta.publishedAt && meta.publishedAt > existingMeta.publishedAt) {
        byName.set(name, entry);
      }
    }
  }
  return [...byName.values()];
}

// --- Filter & transform ---
function processServers(rawServers) {
  const dedupedServers = deduplicateVersions(rawServers);
  console.log(`  Version dedup: ${rawServers.length} -> ${dedupedServers.length} unique servers`);

  const providers = [];
  let skippedNoRemotes = 0;
  let skippedSmithery = 0;
  let skippedJunk = 0;
  let skippedBadUrl = 0;
  let dedupedTransports = 0;

  for (const entry of dedupedServers) {
    const server = entry.server || entry;
    const meta = entry._meta?.['io.modelcontextprotocol.registry/official'] || {};
    const name = server.name || '';

    // Skip Smithery proxies
    if (name.startsWith('ai.smithery')) {
      skippedSmithery++;
      continue;
    }

    // Skip junk/test/template servers
    if (isJunkServer(name, server.title, server.description)) {
      skippedJunk++;
      continue;
    }

    // Must have remotes
    const remotes = server.remotes;
    if (!remotes || remotes.length === 0) {
      skippedNoRemotes++;
      continue;
    }

    // Filter individual remotes
    const validRemotes = [];
    for (const remote of remotes) {
      const url = remote.url || '';
      if (isBadUrl(url)) {
        skippedBadUrl++;
        continue;
      }
      validRemotes.push(remote);
    }

    if (validRemotes.length === 0) {
      skippedNoRemotes++;
      continue;
    }

    // Dedup dual-transport
    const { deduplicated, removed } = deduplicateTransports(validRemotes);
    dedupedTransports += removed;

    // Build provider entry
    const allSSE = deduplicated.every(r => r.type === 'sse');
    const processedRemotes = deduplicated.map(r => ({
      url: r.url,
      transport: r.type === 'sse' ? 'sse' : 'streamable-http',
      expectAuth: hasSecretHeaders(r),
      remoteName: deriveRemoteName(r.url, deduplicated),
    }));

    const displayName = deriveDisplayName(server, name);

    providers.push({
      registryName: name,
      registryVersion: server.version || '0.0.0',
      publishedAt: meta.publishedAt || null,
      displayName,
      sseOnly: allSSE,
      remotes: processedRemotes,
    });
  }

  console.log(`\n  Filter results:`);
  console.log(`    Smithery skipped: ${skippedSmithery}`);
  console.log(`    Junk/test skipped: ${skippedJunk}`);
  console.log(`    No remotes (stdio-only): ${skippedNoRemotes}`);
  console.log(`    Bad URLs filtered: ${skippedBadUrl}`);
  console.log(`    Dual-transport deduped: ${dedupedTransports}`);
  console.log(`    Final providers: ${providers.length}`);
  console.log(`    Total remotes: ${providers.reduce((sum, p) => sum + p.remotes.length, 0)}`);

  return providers;
}

function isBadUrl(url) {
  if (!url) return true;
  if (url.includes('{') || url.includes('}')) return true;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return true;
    if (!parsed.protocol.startsWith('http')) return true;
  } catch {
    return true;
  }
  return false;
}

// --- Junk/test server detection ---

/** Entire namespaces that are test/hosting platforms */
const JUNK_NAMESPACES = [
  'live.alpic',       // Alpic hosting platform — templates and test deployments
  'tech.skybridge',   // Skybridge example/demo apps
];

/** Display name patterns that indicate non-serious servers */
const JUNK_DISPLAY_PATTERNS = [
  /^my mcp serv/i,
  /^template/i,
  /^test\s*$/i,
  /^test server/i,
  /^demo server/i,
  /^example/i,
  /\bexample\b.*\bapp\b/i,
  /^hello world/i,
  /^hey world/i,
  /^second server/i,
  /\bgreat server\b/i,
  /^\(wip\)/i,
];

/** Description patterns that indicate non-serious servers */
const JUNK_DESC_PATTERNS = [
  /^(?:a )?demo (?:server )?(?:entry )?for (?:local )?testing/i,
  /^(?:a )?test (?:mcp )?server/i,
  /^template (?:mcp )?server/i,
];

function isJunkServer(registryName, title, description) {
  // Block entire namespaces
  for (const ns of JUNK_NAMESPACES) {
    if (registryName.startsWith(ns)) return true;
  }

  // Check title against junk patterns
  const t = (title || '').trim();
  for (const re of JUNK_DISPLAY_PATTERNS) {
    if (re.test(t)) return true;
  }

  // Check description against junk patterns
  const d = (description || '').trim();
  for (const re of JUNK_DESC_PATTERNS) {
    if (re.test(d)) return true;
  }

  // Registry name patterns for obvious test entries
  const slug = registryName.split('/')[1] || '';
  if (/^(test|demo|example|sample)-?mcp/.test(slug)) return true;
  if (/^mcp-?(test|demo|example|sample)$/.test(slug)) return true;

  return false;
}

function hasSecretHeaders(remote) {
  if (!remote.headers || !Array.isArray(remote.headers)) return false;
  return remote.headers.some(h => h.isSecret === true);
}

function deduplicateTransports(remotes) {
  const byHost = new Map();
  for (const r of remotes) {
    try {
      const host = new URL(r.url).hostname;
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(r);
    } catch {
      if (!byHost.has('_malformed')) byHost.set('_malformed', []);
      byHost.get('_malformed').push(r);
    }
  }

  const deduplicated = [];
  let removed = 0;

  for (const [, hostRemotes] of byHost) {
    const hasStreamable = hostRemotes.some(r => r.type === 'streamable-http');
    const hasSSE = hostRemotes.some(r => r.type === 'sse');

    if (hasStreamable && hasSSE) {
      for (const r of hostRemotes) {
        if (r.type === 'streamable-http') {
          deduplicated.push(r);
        } else {
          removed++;
        }
      }
    } else {
      deduplicated.push(...hostRemotes);
    }
  }

  return { deduplicated, removed };
}

function deriveRemoteName(url, allRemotes) {
  if (allRemotes.length <= 1) return 'default';

  try {
    const parsed = new URL(url);
    const parts = parsed.hostname.split('.');
    if (parts.length >= 3) {
      const subdomain = parts[0];
      const otherSubdomains = allRemotes
        .filter(r => r.url !== url)
        .map(r => { try { return new URL(r.url).hostname.split('.')[0]; } catch { return ''; } });
      if (!otherSubdomains.includes(subdomain)) {
        return subdomain;
      }
    }

    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length > 0) {
      for (let i = pathParts.length - 1; i >= 0; i--) {
        if (pathParts[i] !== 'mcp' && pathParts[i] !== 'sse') {
          return pathParts[i];
        }
      }
      return pathParts[pathParts.length - 1];
    }

    return parsed.hostname.split('.')[0];
  } catch {
    return 'default';
  }
}

// --- Smart display name derivation ---

/** Generic prefixes to strip from descriptions */
const GENERIC_PREFIXES = [
  /^the\s+official\s+mcp\s+server\s+for\s+(?:the\s+)?/i,
  /^an?\s+mcp\s+server\s+(?:that\s+)?(?:provides?\s+)?(?:access\s+to\s+)?(?:the\s+)?/i,
  /^mcp\s+server\s+for\s+(?:the\s+)?/i,
  /^(?:this\s+is\s+)?(?:an?\s+)?mcp\s+(?:tool|service|integration)\s+(?:for|that)\s+(?:the\s+)?/i,
  /^remote\s+mcp\s+server\s+for\s+(?:the\s+)?/i,
  /^official\s+/i,
];

function deriveDisplayName(server, registryName) {
  const title = (server.title || '').trim();
  const desc = (server.description || '').trim();
  const brandName = extractBrandFromRegistry(registryName);

  // 1. If title exists and is concise (not a full sentence), use it
  if (title && title.length <= 40 && !looksGeneric(title)) {
    return title;
  }

  // 2. Try stripping generic prefixes from title
  if (title) {
    const stripped = stripGenericPrefixes(title);
    if (stripped && stripped !== title && !looksGeneric(stripped)) {
      return capitalize(stripped);
    }
  }

  // 3. Try stripping generic prefixes from description
  if (desc) {
    const stripped = stripGenericPrefixes(desc);
    if (stripped && stripped !== desc) {
      // Take first meaningful chunk (up to first period or comma)
      const chunk = stripped.split(/[.,;!]\s/)[0].trim();
      if (chunk.length > 0 && chunk.length <= 60) {
        return capitalize(chunk);
      }
    }
  }

  // 4. If description is short enough and not generic, use it
  if (desc && desc.length <= 50 && !looksGeneric(desc)) {
    return desc;
  }

  // 5. Fall back to brand name from registryName + suffix from slug
  const slug = registryName.split('/')[1] || '';
  const slugClean = slug.replace(/[-_]/g, ' ').replace(/\bmcp\b/gi, '').replace(/\bserver\b/gi, '').trim();
  if (slugClean && slugClean.toLowerCase() !== brandName.toLowerCase()) {
    return `${brandName} ${capitalize(slugClean)}`.trim();
  }

  return brandName;
}

function stripGenericPrefixes(text) {
  let result = text;
  for (const re of GENERIC_PREFIXES) {
    result = result.replace(re, '');
  }
  return result.trim();
}

function looksGeneric(text) {
  const lower = text.toLowerCase();
  return /^(the |an? )?mcp (server|tool|service)/i.test(lower);
}

function extractBrandFromRegistry(registryName) {
  // "com.cloudflare.mcp/mcp" → "Cloudflare"
  // "io.github.user/my-tool" → "My Tool" (from slug)
  // "ai.exa/exa" → "Exa"
  const [namespace, slug] = registryName.split('/');
  const parts = namespace.split('.');

  // For io.github.X patterns, the brand is the github username — prefer slug
  if (parts[0] === 'io' && parts[1] === 'github') {
    if (slug) {
      return humanizeSlug(slug);
    }
    return parts[2] ? capitalize(parts[2]) : 'Unknown';
  }

  // For com.X / ai.X / app.X patterns, brand is the 2nd segment
  if (parts.length >= 2) {
    const brand = parts[1];
    // Skip very generic brands
    if (brand === 'mcp' || brand === 'server') {
      return slug ? humanizeSlug(slug) : capitalize(brand);
    }
    return capitalize(brand);
  }

  return slug ? humanizeSlug(slug) : 'Unknown';
}

function humanizeSlug(slug) {
  return slug
    .replace(/[-_]/g, ' ')
    .replace(/\bmcp\b/gi, '')
    .replace(/\bserver\b/gi, '')
    .trim()
    .split(/\s+/)
    .map(w => capitalize(w))
    .join(' ') || slug;
}

function capitalize(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// --- Changelog ---
function computeChangelog(oldProviders, newProviders) {
  const oldMap = new Map(oldProviders.map(p => [p.registryName, p]));
  const newMap = new Map(newProviders.map(p => [p.registryName, p]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [name, provider] of newMap) {
    if (!oldMap.has(name)) {
      added.push({ registryName: name, displayName: provider.displayName });
    } else {
      const old = oldMap.get(name);
      if (old.remotes.length !== provider.remotes.length ||
          old.registryVersion !== provider.registryVersion) {
        changed.push({
          registryName: name,
          displayName: provider.displayName,
          oldVersion: old.registryVersion,
          newVersion: provider.registryVersion,
          oldRemoteCount: old.remotes.length,
          newRemoteCount: provider.remotes.length,
        });
      }
    }
  }

  for (const [name, provider] of oldMap) {
    if (!newMap.has(name)) {
      removed.push({ registryName: name, displayName: provider.displayName });
    }
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return null;
  }

  return {
    timestamp: new Date().toISOString(),
    providerCount: newProviders.length,
    added,
    removed,
    changed,
  };
}

// --- Main ---
async function main() {
  console.log('mcpdd registry ingestion');
  if (DRY_RUN) console.log('  (DRY RUN — no files will be written)');
  if (FROM_CACHE) console.log('  (FROM CACHE — no network requests)');
  console.log('');

  let rawServers;

  if (FROM_CACHE) {
    if (!existsSync(RAW_CACHE_FILE)) {
      console.error(`Cache file not found: ${RAW_CACHE_FILE}`);
      console.error('Run without --from-cache first to populate the cache.');
      process.exit(1);
    }
    rawServers = JSON.parse(readFileSync(RAW_CACHE_FILE, 'utf-8'));
    console.log(`Loaded ${rawServers.length} servers from cache`);
  } else {
    console.log('Fetching from MCP Registry...');
    rawServers = await fetchAllServers();
    console.log(`\nTotal raw servers: ${rawServers.length}`);

    // Save raw cache
    if (!DRY_RUN) {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(RAW_CACHE_FILE, JSON.stringify(rawServers));
      const sizeMB = (Buffer.byteLength(JSON.stringify(rawServers)) / 1024 / 1024).toFixed(1);
      console.log(`  Cached raw registry data to ${RAW_CACHE_FILE} (${sizeMB} MB)`);
    }
  }

  console.log('\nProcessing...');
  const providers = processServers(rawServers);

  // Sort by registryName for stable output
  providers.sort((a, b) => a.registryName.localeCompare(b.registryName));

  // Stats
  const multiRemote = providers.filter(p => p.remotes.length > 1);
  console.log(`\n  Multi-remote providers: ${multiRemote.length}`);
  if (multiRemote.length > 0) {
    multiRemote
      .sort((a, b) => b.remotes.length - a.remotes.length)
      .slice(0, 5)
      .forEach(p => console.log(`    ${p.registryName}: ${p.remotes.length} remotes`));
  }

  // Show some display name examples
  console.log(`\n  Display name samples:`);
  providers.slice(0, 10).forEach(p => {
    console.log(`    ${p.registryName.padEnd(45)} → "${p.displayName}"`);
  });

  if (DRY_RUN) {
    console.log('\n  Dry run — not writing files.');
    console.log(`  Would write ${providers.length} providers to ${SERVERS_FILE}`);
    return;
  }

  // Load previous for changelog
  let oldProviders = [];
  if (existsSync(SERVERS_FILE)) {
    try {
      oldProviders = JSON.parse(readFileSync(SERVERS_FILE, 'utf-8'));
    } catch { /* first run */ }
  }

  // Write servers.json
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SERVERS_FILE, JSON.stringify(providers, null, 2));
  console.log(`\n  Wrote ${providers.length} providers to ${SERVERS_FILE}`);

  // Compute and append changelog
  const changeEntry = computeChangelog(oldProviders, providers);
  if (changeEntry) {
    let changelog = [];
    if (existsSync(CHANGELOG_FILE)) {
      try {
        changelog = JSON.parse(readFileSync(CHANGELOG_FILE, 'utf-8'));
      } catch { /* fresh */ }
    }
    changelog.unshift(changeEntry);
    if (changelog.length > 90) changelog = changelog.slice(0, 90);
    writeFileSync(CHANGELOG_FILE, JSON.stringify(changelog, null, 2));
    console.log(`  Changelog: +${changeEntry.added.length} added, -${changeEntry.removed.length} removed, ~${changeEntry.changed.length} changed`);
  } else {
    console.log('  Changelog: no changes detected');
  }

  console.log('\nDone.');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, retries) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(15000) });
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`  (retry ${attempt}/${retries} after ${err.message})`);
      await delay(1000 * attempt);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
