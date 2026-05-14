// Discover the V8 Inspector / Chrome DevTools WebSocket URL exposed by
// `node --inspect`, Chrome, or Electron.
//
// The inspector serves http://host:port/json which returns a JSON array of
// targets; each debuggable target has a `webSocketDebuggerUrl`.

import http from 'node:http';

export async function discover({ host = '127.0.0.1', port = 9229, timeoutMs = 5000, target = null } = {}) {
  const targets = await listTargets({ host, port, timeoutMs });
  const selected = selectTarget(targets, target);
  return selected.webSocketDebuggerUrl;
}

export async function listTargets({ host = '127.0.0.1', port = 9229, timeoutMs = 5000 } = {}) {
  // The inspector advertises its WS URL on stderr a few ms before the HTTP
  // discovery endpoint starts accepting connections; poll briefly.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const body = await httpGet({ host, port, path: '/json/list', timeoutMs: 1000 });
      const targets = JSON.parse(body);
      if (!Array.isArray(targets) || targets.length === 0) throw new Error('empty target list');
      return targets;
    } catch (err) {
      if (Date.now() >= deadline) throw new Error(`inspector discovery failed at http://${host}:${port}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

export function selectTarget(targets, selector = null) {
  const debuggable = targets.filter((target) => target.webSocketDebuggerUrl);
  if (debuggable.length === 0) throw new Error('no debuggable targets found');
  if (!selector) return debuggable[0];

  const query = String(selector).toLowerCase();
  const matches = debuggable.filter((target) => targetSearchText(target).includes(query));
  if (matches.length === 0) {
    throw new Error(`no target matching ${JSON.stringify(selector)}\n${formatTargetList(debuggable)}`);
  }
  if (matches.length === 1) return matches[0];

  const exact = matches.filter((target) => targetFields(target).some((field) => field.toLowerCase() === query));
  if (exact.length === 1) return exact[0];

  const titlePrefix = matches.filter((target) => String(target.title ?? '').toLowerCase().startsWith(query));
  if (titlePrefix.length === 1) return titlePrefix[0];

  throw new Error(`target selector ${JSON.stringify(selector)} matched multiple targets\n${formatTargetList(matches)}`);
}

export function formatTargetList(targets) {
  return targets.map((target, i) => {
    const title = target.title || '(untitled)';
    const type = target.type || 'unknown';
    const url = target.url || '';
    const id = target.id || '';
    return `${i + 1}. [${type}] ${title}${url ? ` - ${url}` : ''}${id ? ` (${id})` : ''}`;
  }).join('\n');
}

function targetFields(target) {
  return [
    target.id,
    target.type,
    target.title,
    target.url,
    target.description,
  ].filter((value) => value !== undefined && value !== null).map(String);
}

function targetSearchText(target) {
  return targetFields(target).join('\n').toLowerCase();
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
