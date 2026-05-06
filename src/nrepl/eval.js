// The `eval` op: routes either to Runtime.evaluate (default) or to the
// patcher (when the client passed `file` and the code is a set of named
// top-level decls that already exist in that script).

import { formatRemoteObject, formatException } from '../format.js';
import { parseAsTopLevelDecls, patchScript, findTopLevelDecl } from '../patch.js';
import * as acorn from 'acorn';

export async function handleEval({ msg, session, cdp, scripts, send }) {
  const code = msg.code ?? '';
  const file = msg.file;

  if (file) {
    const scriptId = scripts.scriptIdForPath(file);
    const decls = parseAsTopLevelDecls(code);
    if (scriptId && decls && allDeclsExist(cdp, scriptId, decls, scripts)) {
      try {
        const res = await patchScript(cdp, scriptId, code);
        if (res.status !== 'Ok') {
          const detail = res.exceptionDetails ? formatException(res.exceptionDetails).text : '';
          send({ id: msg.id, session: session.id, err: `patch failed: ${res.status}${detail ? ': ' + detail : ''}\n` });
          send({ id: msg.id, session: session.id, status: ['done', 'patch-failed'] });
          return;
        }
        send({ id: msg.id, session: session.id, value: '#patched ' + res.names.join(',') });
        send({ id: msg.id, session: session.id, status: ['done'] });
        return;
      } catch (err) {
        send({ id: msg.id, session: session.id, err: 'patch error: ' + err.message + '\n' });
        send({ id: msg.id, session: session.id, status: ['done', 'patch-failed'] });
        return;
      }
    }
  }

  // Default path: Runtime.evaluate against the session's execution context.
  session.lastEvalId = msg.id;
  try {
    const res = await cdp.send('Runtime.evaluate', {
      expression: code,
      objectGroup: 'nrepl',
      includeCommandLineAPI: true,
      generatePreview: true,
      returnByValue: false,
      awaitPromise: true,
      replMode: true,
      contextId: session.contextId ?? undefined,
    });

    if (res.exceptionDetails) {
      const { text, className } = formatException(res.exceptionDetails);
      send({ id: msg.id, session: session.id, err: text + '\n' });
      send({ id: msg.id, session: session.id, ex: className, 'root-ex': className });
      send({ id: msg.id, session: session.id, status: ['done', 'eval-error'] });
    } else {
      send({ id: msg.id, session: session.id, value: formatRemoteObject(res.result) });
      send({ id: msg.id, session: session.id, status: ['done'] });
    }
  } catch (err) {
    send({ id: msg.id, session: session.id, err: 'eval transport error: ' + err.message + '\n' });
    send({ id: msg.id, session: session.id, status: ['done', 'eval-error'] });
  } finally {
    session.lastEvalId = null;
  }
}

function allDeclsExist(_cdp, _scriptId, decls, _scripts) {
  // We don't fetch the source up front (that would double our CDP traffic).
  // Existence will be re-checked inside spliceDecls; we only need a
  // best-effort signal that the user's intent is "patch", not "evaluate".
  // If any decl looks like it could be a redefinition (i.e., we have a file
  // and the code parsed as named decls), call it a patch.
  return decls.length > 0;
}

// Exposed for tests.
export { findTopLevelDecl as _findTopLevelDecl };
export const _acorn = acorn;
