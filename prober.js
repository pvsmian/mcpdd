import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const PROBE_TIMEOUT_MS = parseInt(process.env.PROBE_TIMEOUT_MS || '10000');

/**
 * Probe a single MCP server and return a CheckResult.
 *
 * @param {Object} serverConfig - { id, name, url, transport, expectAuth }
 * @returns {Promise<Object>} CheckResult: { timestamp, status, auth, latencyMs, toolCount, error }
 */
export async function probeServer(serverConfig) {
  const timestamp = Date.now();

  // Race the probe against a timeout
  try {
    const result = await Promise.race([
      doProbe(serverConfig),
      timeout(PROBE_TIMEOUT_MS),
    ]);
    return { timestamp, ...result };
  } catch (err) {
    return {
      timestamp,
      status: 'down',
      auth: serverConfig.expectAuth ? 'protected' : 'unknown',
      latencyMs: null,
      toolCount: null,
      error: err.message || String(err),
    };
  }
}

function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Probe timed out after ${ms}ms`)), ms)
  );
}

async function doProbe(serverConfig) {
  const url = new URL(serverConfig.url);
  let transport;
  let client;

  try {
    // Create the appropriate transport
    if (serverConfig.transport === 'sse') {
      transport = new SSEClientTransport(url);
    } else {
      transport = new StreamableHTTPClientTransport(url);
    }

    // Create client and attempt connect (which does the initialize handshake)
    client = new Client({ name: 'mcpdd', version: '0.1.0' });
    await client.connect(transport);

    // If we got here, initialize succeeded — server is alive and open
    // Now measure ping latency
    const pingStart = Date.now();
    try {
      await client.ping();
    } catch (pingErr) {
      // Ping failed but server responded to initialize — degraded
      return {
        status: 'degraded',
        auth: 'open',
        latencyMs: Date.now() - pingStart,
        toolCount: null,
        error: `ping failed: ${pingErr.message}`,
      };
    }
    const latencyMs = Date.now() - pingStart;

    // Now try tools/list
    let toolCount = null;
    try {
      const result = await client.listTools();
      toolCount = result.tools ? result.tools.length : 0;
    } catch (toolsErr) {
      // tools/list failed but init + ping worked — unhealthy
      return {
        status: 'unhealthy',
        auth: 'open',
        latencyMs,
        toolCount: null,
        error: `tools/list failed: ${toolsErr.message}`,
      };
    }

    // Full success
    return {
      status: latencyMs > 2000 ? 'degraded' : (latencyMs > 500 ? 'degraded' : 'healthy'),
      auth: 'open',
      latencyMs,
      toolCount,
      error: null,
    };
  } catch (err) {
    // Classify the error from the connect/initialize attempt
    return classifyConnectError(err, serverConfig);
  } finally {
    // Clean up with a timeout to prevent zombie connections
    try {
      const closePromise = client ? client.close() : (transport ? transport.close() : Promise.resolve());
      await Promise.race([
        closePromise,
        new Promise(resolve => setTimeout(resolve, 3000)),
      ]);
    } catch (_) {
      // ignore cleanup errors
    }
  }
}

/**
 * Classify an error from the connect attempt into a CheckResult.
 */
function classifyConnectError(err, serverConfig) {
  const msg = err.message || String(err);
  const code = err.code;  // StreamableHTTPError has .code, SseError has .code

  // HTTP 401/403 → server is alive but protected
  if (code === 401 || code === 403 ||
      err.constructor?.name === 'UnauthorizedError' ||
      msg.includes('401') || msg.includes('Unauthorized') ||
      msg.includes('403') || msg.includes('Forbidden')) {
    return {
      status: 'healthy',
      auth: 'protected',
      latencyMs: null,
      toolCount: null,
      error: null,
    };
  }

  // HTTP 5xx → down
  if (code >= 500 && code < 600) {
    return {
      status: 'down',
      auth: serverConfig.expectAuth ? 'protected' : 'unknown',
      latencyMs: null,
      toolCount: null,
      error: `HTTP ${code}: ${msg}`,
    };
  }

  // Connection-level errors (ECONNREFUSED, ENOTFOUND, etc.) → down
  if (err.cause?.code === 'ECONNREFUSED' || err.cause?.code === 'ENOTFOUND' ||
      err.cause?.code === 'ECONNRESET' || err.cause?.code === 'ETIMEDOUT' ||
      msg.includes('fetch failed') || msg.includes('ECONNREFUSED') ||
      msg.includes('ENOTFOUND')) {
    return {
      status: 'down',
      auth: serverConfig.expectAuth ? 'protected' : 'unknown',
      latencyMs: null,
      toolCount: null,
      error: msg,
    };
  }

  // HTTP redirect or other known codes that indicate "alive but broken MCP"
  if (code >= 300 && code < 500 && code !== 401 && code !== 403) {
    return {
      status: 'unhealthy',
      auth: serverConfig.expectAuth ? 'protected' : 'open',
      latencyMs: null,
      toolCount: null,
      error: `HTTP ${code}: ${msg}`,
    };
  }

  // Anything else (bad JSON-RPC, parse errors, etc.) → unhealthy
  // The server responded but MCP layer is broken
  return {
    status: 'unhealthy',
    auth: serverConfig.expectAuth ? 'protected' : 'open',
    latencyMs: null,
    toolCount: null,
    error: msg,
  };
}

// Self-test when run directly: node prober.js
if (process.argv[1] && process.argv[1].endsWith('prober.js')) {
  const testServer = {
    id: 'test',
    name: 'GitMCP',
    url: 'https://gitmcp.io',
    transport: 'streamable-http',
    expectAuth: false,
  };

  console.log(`Probing ${testServer.name} at ${testServer.url}...`);
  probeServer(testServer).then(result => {
    console.log('Result:', JSON.stringify(result, null, 2));
    process.exit(0);
  });
}
