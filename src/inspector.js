// Discover the V8 Inspector WebSocket URL exposed by `node --inspect`.
//
// The inspector serves http://host:port/json which returns a JSON array of
// targets; each has a `webSocketDebuggerUrl`. We pick the first one (Node
// only ever exposes one main target per process unless workers are involved).

import http from 'node:http';

export async function discover({ host = '127.0.0.1', port = 9229, timeoutMs = 5000 } = {}) {
  // The inspector advertises its WS URL on stderr a few ms before the HTTP
  // discovery endpoint starts accepting connections; poll briefly.
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  for (;;) {
    try {
      const body = await httpGet({ host, port, path: '/json/list', timeoutMs: 1000 });
      const targets = JSON.parse(body);
      if (!Array.isArray(targets) || targets.length === 0) throw new Error('empty target list');
      const target = targets.find((t) => t.webSocketDebuggerUrl) ?? targets[0];
      if (!target.webSocketDebuggerUrl) throw new Error('no webSocketDebuggerUrl on target');
      return target.webSocketDebuggerUrl;
    } catch (err) {
      lastErr = err;
      if (Date.now() >= deadline) throw new Error(`inspector discovery failed at http://${host}:${port}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

function httpGet({ host, port, path, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => {});
    });
    // Permanent sink to absorb late socket errors after we've already rejected.
    req.on('error', (err) => reject(err));
    req.on('socket', (s) => s.on('error', () => {}));
    req.setTimeout(timeoutMs, () => { try { req.destroy(new Error('inspector discovery timeout')); } catch {} });
  });
}
