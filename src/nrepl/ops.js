// nREPL op dispatch table.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { handleEval } from './eval.js';

const SUPPORTED_OPS = {
  clone: { doc: 'Create a new session.' },
  close: { doc: 'Close a session.' },
  describe: { doc: 'Describe supported ops.' },
  eval: { doc: 'Evaluate code in a session. Pass `file` to enable live-patch routing.' },
  'ls-sessions': { doc: 'List active sessions.' },
  interrupt: { doc: 'Interrupt the running eval (best-effort via Runtime.terminateExecution).' },
  'load-file': { doc: 'Load contents of a file as eval (file content in `file`, optional `file-path`).' },
};

export async function dispatch({ msg, ctx, send }) {
  const op = msg.op;
  switch (op) {
    case 'clone': return opClone({ msg, ctx, send });
    case 'close': return opClose({ msg, ctx, send });
    case 'describe': return opDescribe({ msg, send });
    case 'eval': return opEval({ msg, ctx, send });
    case 'ls-sessions': return opLsSessions({ msg, ctx, send });
    case 'interrupt': return opInterrupt({ msg, ctx, send });
    case 'load-file': return opLoadFile({ msg, ctx, send });
    default:
      send({ id: msg.id, status: ['done', 'error', 'unknown-op'] });
  }
}

function opDescribe({ msg, send }) {
  const ops = {};
  for (const [k, v] of Object.entries(SUPPORTED_OPS)) ops[k] = { doc: v.doc };
  send({
    id: msg.id,
    ops,
    versions: { 'nrepl-js': { major: 0, minor: 1, incremental: 0, 'version-string': '0.1.0' } },
    status: ['done'],
  });
}

function opClone({ msg, ctx, send }) {
  const id = randomUUID();
  const session = { id, contextId: ctx.defaultContextId, lastEvalId: null };
  ctx.sessions.set(id, session);
  send({ id: msg.id, 'new-session': id, status: ['done'] });
}

function opClose({ msg, ctx, send }) {
  const sid = msg.session;
  if (sid) ctx.sessions.delete(sid);
  send({ id: msg.id, session: sid, status: ['done', 'session-closed'] });
}

function opLsSessions({ msg, ctx, send }) {
  send({ id: msg.id, sessions: Array.from(ctx.sessions.keys()), status: ['done'] });
}

async function opEval({ msg, ctx, send }) {
  const session = ctx.sessions.get(msg.session);
  if (!session) {
    send({ id: msg.id, status: ['done', 'error', 'unknown-session'] });
    return;
  }
  // Track which session is responsible for currently flowing console output.
  ctx.activeEvalSession = session;
  try {
    await handleEval({ msg, session, cdp: ctx.cdp, scripts: ctx.scripts, send });
  } finally {
    ctx.activeEvalSession = null;
  }
}

async function opLoadFile({ msg, ctx, send }) {
  const session = ctx.sessions.get(msg.session);
  if (!session) {
    send({ id: msg.id, status: ['done', 'error', 'unknown-session'] });
    return;
  }
  let code = msg.file;
  if (!code && msg['file-path']) code = await fs.readFile(msg['file-path'], 'utf8');
  await handleEval({
    msg: { ...msg, op: 'eval', code, file: msg['file-path'] ?? msg['file-name'] ?? undefined },
    session, cdp: ctx.cdp, scripts: ctx.scripts, send,
  });
}

async function opInterrupt({ msg, ctx, send }) {
  try {
    await ctx.cdp.send('Runtime.terminateExecution');
    send({ id: msg.id, status: ['done', 'interrupted'] });
  } catch (err) {
    send({ id: msg.id, err: 'interrupt failed: ' + err.message + '\n', status: ['done', 'error'] });
  }
}
