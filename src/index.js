// Programmatic entry point.

import { discover } from './inspector.js';
import { connect } from './cdp.js';
import { createScriptRegistry } from './scripts.js';
import { startServer } from './nrepl/server.js';

export async function start({ inspectHost = '127.0.0.1', inspectPort = 9229, inspectTarget = null, inspectWsUrl = null, port = 0, host = '127.0.0.1', debug = false } = {}) {
  const wsUrl = inspectWsUrl ?? await discover({ host: inspectHost, port: inspectPort, target: inspectTarget });
  const cdp = await connect(wsUrl);
  const scripts = createScriptRegistry(cdp);
  const { server, port: actualPort, ctx } = await startServer({ cdp, scripts, port, host, debug });
  return {
    port: actualPort,
    host,
    cdp,
    server,
    ctx,
    async close() {
      // Close the CDP connection first so the inspected process doesn't hang
      // printing "Waiting for the debugger to disconnect...".
      cdp.close();
      // Destroy all active nREPL client sockets so server.close() resolves
      // immediately instead of waiting for them to finish on their own.
      for (const conn of ctx.connections) {
        try { conn.socket.destroy(); } catch {}
      }
      await new Promise((r) => server.close(() => r()));
    },
  };
}

export { discover, connect, createScriptRegistry, startServer };
export { listTargets, selectTarget, formatTargetList } from './inspector.js';
