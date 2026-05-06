// Wires Runtime.consoleAPICalled and Runtime.exceptionThrown to a callback
// that fans out to interested nREPL sessions.
//
// Mapping: log/info/debug/dir/dirxml/trace -> stdout
//          error/warn/assert/exception     -> stderr
// Anything else falls through to stdout.

import { formatRemoteObject, formatException } from './format.js';

const STDERR_TYPES = new Set(['error', 'warn', 'assert', 'exception']);

export function attachConsole(cdp, onMessage) {
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const stream = STDERR_TYPES.has(p.type) ? 'err' : 'out';
    const text = (p.args ?? []).map(formatRemoteObject).join(' ') + '\n';
    onMessage({ stream, text, contextId: p.executionContextId });
  });

  cdp.on('Runtime.exceptionThrown', (p) => {
    const { text, className } = formatException(p.exceptionDetails);
    onMessage({ stream: 'err', text: text + '\n', contextId: p.exceptionDetails?.executionContextId, className });
  });
}
