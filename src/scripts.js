// Tracks Debugger.scriptParsed events so we can map a filesystem path to a
// scriptId for use with Debugger.getScriptSource / setScriptSource.
//
// The inspector reports `url` as `file:///abs/path.js` for files Node loaded
// from disk; for evaluated snippets it's empty. We normalize to absolute
// fs paths.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function createScriptRegistry(cdp) {
  const byId = new Map();      // scriptId -> { url, path, source? }
  const byPath = new Map();    // absolute path -> scriptId

  cdp.on('Debugger.scriptParsed', (params) => {
    const url = params.url || '';
    let p = null;
    if (url.startsWith('file://')) {
      try { p = fileURLToPath(url); } catch { p = null; }
    }
    byId.set(params.scriptId, { url, path: p });
    if (p) byPath.set(p, params.scriptId);
  });

  return {
    scriptIdForPath(file) {
      const abs = path.resolve(file);
      return byPath.get(abs) ?? null;
    },
    info(scriptId) { return byId.get(scriptId) ?? null; },
    all() { return Array.from(byId.entries()); },
  };
}
