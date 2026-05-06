// Programmatic entry point.

import { discover } from './inspector.js';
import { connect } from './cdp.js';
import { createScriptRegistry } from './scripts.js';
import { startServer } from './nrepl/server.js';

export async function start({ inspectHost = '127.0.0.1', inspectPort = 9229, port = 0, host = '127.0.0.1' } = {}) {
  const wsUrl = await discover({ host: inspectHost, port: inspectPort });
  const cdp = await connect(wsUrl);
  const scripts = createScriptRegistry(cdp);
  const { server, port: actualPort } = await startServer({ cdp, scripts, port, host });
  return {
    port: actualPort,
    host,
    cdp,
    server,
    async close() {
      await new Promise((r) => server.close(() => r()));
      cdp.close();
    },
  };
}

export { discover, connect, createScriptRegistry, startServer };
