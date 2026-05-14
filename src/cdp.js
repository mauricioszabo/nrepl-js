// Tiny JSON-RPC client over the V8 Inspector WebSocket.
//
// CDP requests look like { id, method, params }, responses are
// { id, result } or { id, error }. Notifications have { method, params } with
// no id. We multiplex by monotonic id and dispatch notifications via on().

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export async function connect(wsUrl, { retryMs = 3000 } = {}) {
  const deadline = Date.now() + retryMs;
  let ws;
  for (;;) {
    ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    // Permanent error sink so trailing socket errors during retry don't crash.
    ws.on('error', () => {});
    try {
      await new Promise((resolve, reject) => {
        const onOpen = () => { ws.off('error', onErr); resolve(); };
        const onErr = (err) => { ws.off('open', onOpen); reject(err); };
        ws.once('open', onOpen);
        ws.once('error', onErr);
      });
      break;
    } catch (err) {
      try { ws.terminate(); } catch {}
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const events = new EventEmitter();
  events.setMaxListeners(0);
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        if( (msg.error.message ?? '').match(/breakpoint.*exists./i) ) {
          resolve({})
        } else {
          reject(Object.assign(new Error(msg.error.message || 'CDP error'), { code: msg.error.code, data: msg.error.data }));
        }
      }
      else resolve(msg.result ?? {});
      return;
    }
    if (msg.method) events.emit(msg.method, msg.params ?? {});
  });

  ws.on('close', () => {
    closed = true;
    for (const { reject } of pending.values()) reject(new Error('CDP connection closed'));
    pending.clear();
    events.emit('__closed__');
  });

  ws.on('error', (err) => events.emit('__error__', err));

  function send(method, params = {}) {
    if (closed) return Promise.reject(new Error('CDP connection closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (err) {
          pending.delete(id);
          reject(err);
        }
      });
    });
  }

  function on(event, listener) { events.on(event, listener); return () => events.off(event, listener); }
  function close() { try { ws.close(); } catch {} }

  return { send, on, close, get isClosed() { return closed; } };
}
