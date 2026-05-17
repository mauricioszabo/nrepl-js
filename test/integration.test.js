// Full end-to-end test: spawn `node --inspect` running our fixture, attach
// nrepl-js, drive it through a real bencode TCP client, exercise eval +
// console capture + live patch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode, decode } from '../src/bencode.js';
import { start } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'sample.cjs');

function client(port) {
  const sock = net.connect(port);
  let buf = Buffer.alloc(0);
  const inbox = [];
  const waiters = [];
  sock.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const r = decode(buf);
      if (!r) break;
      buf = r.rest;
      if (waiters.length) waiters.shift()(r.value);
      else inbox.push(r.value);
    }
  });
  return {
    sock,
    send(msg) { sock.write(encode(msg)); },
    next(timeoutMs = 3000) {
      if (inbox.length) return Promise.resolve(inbox.shift());
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting for nREPL frame')), timeoutMs);
        waiters.push((v) => { clearTimeout(t); resolve(v); });
      });
    },
    close() { sock.end(); },
  };
}

async function collectUntilDone(c, id, timeoutMs = 4000) {
  const frames = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = Math.max(0, deadline - Date.now());
    const f = await c.next(remaining || 1);
    frames.push(f);
    if (f.id === id && Array.isArray(f.status) && f.status.includes('done')) return frames;
  }
}

async function spawnInspectedFixture() {
  const child = spawn(process.execPath, [
    '--inspect=0',
    '-e',
    `const f = require(${JSON.stringify(FIXTURE)}); setInterval(f.tick, 50);`,
  ], { stdio: ['ignore', 'ignore', 'pipe'], cwd: path.dirname(FIXTURE) });

  const port = await new Promise((resolve, reject) => {
    let stderr = '';
    const onData = (chunk) => {
      stderr += chunk.toString('utf8');
      const m = stderr.match(/Debugger listening on ws:\/\/[^:]+:(\d+)/);
      if (m) { child.stderr.off('data', onData); resolve(Number(m[1])); }
    };
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error('node exited: ' + code)));
    setTimeout(() => reject(new Error('inspector port timeout')), 4000);
  });
  return { child, inspectPort: port };
}

test('end-to-end: clone, eval, console capture', async () => {
  const { child, inspectPort } = await spawnInspectedFixture();
  let server;
  try {
    server = await start({ inspectPort });
    const c = client(server.port);
    try {
      c.send({ op: 'clone', id: '1' });
      const cloneRes = await c.next();
      assert.equal(cloneRes.status[0], 'done');
      const sid = cloneRes['new-session'];
      assert.ok(sid);

      c.send({ op: 'eval', id: '2', session: sid, code: '40 + 2' });
      const frames = await collectUntilDone(c, '2');
      const valFrame = frames.find((f) => f.value !== undefined);
      assert.equal(valFrame.value, '42');

      // console capture: invoke our fixture's tick and assert we see 'tick='.
      c.send({ op: 'eval', id: '3', session: sid, code: 'require(' + JSON.stringify(FIXTURE) + ').tick()' });
      const f3 = await collectUntilDone(c, '3');
      const out = f3.find((f) => f.out !== undefined && /tick=/.test(f.out));
      assert.ok(out, 'expected tick= console output, got ' + JSON.stringify(f3));
    } finally {
      c.close();
    }
  } finally {
    if (server) await server.close();
    child.kill();
  }
});

test('live patch swaps a private function', async () => {
  const { child, inspectPort } = await spawnInspectedFixture();
  let server;
  try {
    server = await start({ inspectPort });
    const c = client(server.port);
    try {
      c.send({ op: 'clone', id: '1' });
      const sid = (await c.next())['new-session'];

      // Sanity: doWork returns 101 before the patch.
      c.send({ op: 'eval', id: '2', session: sid, code: 'require(' + JSON.stringify(FIXTURE) + ').doWork()' });
      const before = await collectUntilDone(c, '2');
      assert.equal(before.find((f) => f.value !== undefined).value, '101');

      // Patch the *unexported* helper.
      c.send({ op: 'eval', id: '3', session: sid, file: FIXTURE, code: 'function helper(){ return 999 }' });
      const patchFrames = await collectUntilDone(c, '3');
      const ok = patchFrames.find((f) => typeof f.value === 'string' && f.value.startsWith('#patched'));
      assert.ok(ok, 'expected #patched response, got ' + JSON.stringify(patchFrames));

      // Now doWork's existing closure must call the new helper.
      c.send({ op: 'eval', id: '4', session: sid, code: 'require(' + JSON.stringify(FIXTURE) + ').doWork()' });
      const after = await collectUntilDone(c, '4');
      assert.equal(after.find((f) => f.value !== undefined).value, '1099');
    } finally {
      c.close();
    }
  } finally {
    if (server) await server.close();
    child.kill();
  }
});
