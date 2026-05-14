// nREPL TCP server. Each TCP connection multiplexes any number of sessions;
// a session is just a UUID we issue on `clone`. Bencode frames are decoded
// from a per-connection buffer.

import net from 'node:net';
import fs from 'node:fs';
import { encode, decode } from '../bencode.js';
import { dispatch } from './ops.js';
import {instrumentSource} from './patch-functions.js';
import { parseResult, formatRemoteObject, formatException} from './format.js';

// Open /dev/tty so debug output goes directly to the terminal even when
// stdout is piped to a parent process (e.g. an editor reading nREPL over stdio).
function openDebugSink() {
  try {
    const fd = fs.openSync('/dev/tty', 'w');
    return (line) => fs.writeSync(fd, line + '\n');
  } catch {
    // Fallback: stderr. At least it won't corrupt a bencode stream on stdout.
    return (line) => process.stderr.write(line + '\n');
  }
}

export async function startServer({ cdp, scripts, port = 0, host = '127.0.0.1', debug = false }) {
  const dbg = debug ? openDebugSink() : null;
  // One global execution context discovered from the inspector.
  let defaultContextId;
  try {
    const ctxs = await cdp.send('Runtime.enable');
    defaultContextId = ctxs.context.id;
  } catch {}
  // Runtime.enable on Node typically does not return the context; we instead
  // capture it from the executionContextCreated event below.

  cdp.on('Runtime.executionContextCreated', (p) => {
    if (defaultContextId == null) defaultContextId = p.context?.id;
    ctx.defaultContextId ??= p.context?.id;
  });

  const ctx = {
    cdp,
    scripts,
    sessions: new Map(),
    defaultContextId,
    activeEvalSession: null,
    connections: new Set(),
  };

  // Re-enable so the executionContextCreated event fires (clearing/re-enabling
  // is the standard pattern when attaching to an already-running target).
  try { await cdp.send('Runtime.enable'); } catch {}
  try { await cdp.send('Debugger.enable'); } catch {}
  try { await cdp.send('Runtime.runIfWaitingForDebugger'); } catch {}

  cdp.on("Debugger.scriptParsed", async (ev) => {
    // const result = await cdp.send('Runtime.evaluate', {
    //   expression: "global.__lazuli ||= { watchPoints: {}, watchPointsIds: {}, sources: {}}",
    //   awaitPromise: true,
    // })

    if( !ev.url.match(/node_modules/) ) {
      instrumentSource(cdp, ev)
    }
    // console.log("EVENT", ev)
  });

  let firstPause = true
  cdp.on("Debugger.paused", ev => {
    if (firstPause) cdp.send("Debugger.resume")
    firstPause = false
  })

  attachConsole(cdp, ({ stream, text, structured }) => {
    const writers = [];
    for (const conn of ctx.connections) writers.push((m) => conn.send(m));
    // If there's an active eval, attribute output to that session/eval; else
    // broadcast to every connected session.
    const active = ctx.activeEvalSession;
    if (active) {
      for (const conn of ctx.connections) {
        if (!conn.sessions.has(active.id)) continue;
        conn.send({
          id: active.lastEvalId ?? '0',
          session: active.id,
          [stream]: text,
          structured
        });
      }
      return;
    }
    for (const conn of ctx.connections) {
      for (const sid of conn.sessions) {
        conn.send({ id: '0', session: sid, [stream]: text, structured });
      }
    }
  });

  const server = net.createServer((socket) => handleConnection(socket, ctx, dbg));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return { server, port: server.address().port, host, ctx };
}

function handleConnection(socket, ctx, dbg) {
  let buf = Buffer.alloc(0);
  const sessions = new Set(); // sessions opened on this connection

  const conn = {
    socket,
    sessions,
    send(msg) {
      if (dbg) dbg(' -> ' + JSON.stringify(msg));
      try { socket.write(encode(msg)); } catch {}
    },
  };
  ctx.connections.add(conn);

  socket.on('data', async (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const r = decode(buf);
      if (!r) break;
      buf = r.rest;
      const msg = r.value;
      if (dbg) dbg(' <- ' + JSON.stringify(msg));
      const send = (m) => conn.send(m);
      const before = new Set(ctx.sessions.keys());
      try {
        await dispatch({ msg, ctx, send });
      } catch (err) {
        send({ id: msg.id, err: 'op error: ' + err.message + '\n', status: ['done', 'error'] });
      }
      // Sessions created by this op (i.e. clone) belong to this connection.
      for (const sid of ctx.sessions.keys()) if (!before.has(sid)) sessions.add(sid);
      if (msg.op === 'close' && msg.session) sessions.delete(msg.session);
    }
  });

  socket.on('close', () => { ctx.connections.delete(conn); });
  socket.on('error', () => {});
}

const STDERR_TYPES = new Set(['error', 'warn', 'assert', 'exception']);
function attachConsole(cdp, onMessage) {
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const stream = STDERR_TYPES.has(p.type) ? 'err' : 'out';
    const text = (p.args ?? []).map(formatRemoteObject).join(' ') + '\n';
    const structuredLog = (p.args ?? []).map( async object =>
      object.type === 'string' ?
        { string: object.value } :
        { structured: await parseResult(cdp, object)}
    )
    Promise.all(structuredLog).then(l => {
      onMessage({ stream, text, structured: l.concat([{string: "\n"}]) });
    })
  });

  cdp.on('Runtime.exceptionThrown', (p) => {
    const text = formatException(p.exceptionDetails);
    onMessage({ stream: 'err', text: text + '\n'});
  });
}
