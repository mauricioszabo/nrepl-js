// Integration test for module-scope eval (reading private variables).

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
      const r = decode(buf); if (!r) break; buf = r.rest;
      if (waiters.length) waiters.shift()(r.value); else inbox.push(r.value);
    }
  });
  return {
    sock,
    send(msg) { sock.write(encode(msg)); },
    next(ms = 5000) {
      if (inbox.length) return Promise.resolve(inbox.shift());
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), ms);
        waiters.push((v) => { clearTimeout(t); resolve(v); });
      });
    },
    close() { sock.end(); },
  };
}

async function collectUntilDone(c, id, ms = 6000) {
  const frames = [];
  const deadline = Date.now() + ms;
  for (;;) {
    const f = await c.next(Math.max(0, deadline - Date.now()) || 1);
    frames.push(f);
    if (f.id === id && Array.isArray(f.status) && f.status.includes('done')) return frames;
  }
}

async function spawnFixture() {
  const child = spawn(process.execPath, [
    '--inspect=0', '-e',
    `const f = require(${JSON.stringify(FIXTURE)}); setInterval(f.tick, 500);`,
  ], { stdio: ['ignore', 'ignore', 'pipe'], cwd: path.dirname(FIXTURE) });
  const inspectPort = await new Promise((resolve, reject) => {
    let s = '';
    child.stderr.on('data', (c) => { s += c; const m = s.match(/ws:\/\/[^:]+:(\d+)/); if (m) resolve(Number(m[1])); });
    child.once('exit', (code) => reject(new Error('node exited: ' + code)));
    setTimeout(() => reject(new Error('inspector timeout')), 4000);
  });
  return { child, inspectPort };
}

test('scope eval reads a private variable', async () => {
  const { child, inspectPort } = await spawnFixture();
  let server;
  try {
    server = await start({ inspectPort });
    const c = client(server.port);
    try {
      c.send({ op: 'clone', id: '1' });
      const sid = (await c.next())['new-session'];

      // `helper` is private; evaluate it in the module's scope.
      c.send({ op: 'eval', id: '2', session: sid, file: FIXTURE, code: 'helper()' });
      const frames = await collectUntilDone(c, '2');
      const val = frames.find((f) => f.value !== undefined)?.value;
      assert.equal(val, '1', 'expected helper() === 1, got ' + JSON.stringify(frames));
    } finally {
      c.close();
    }
  } finally {
    if (server) await server.close();
    child.kill();
  }
});

test('scope eval does not persist after the call (source is restored)', async () => {
  const { child, inspectPort } = await spawnFixture();
  let server;
  try {
    server = await start({ inspectPort });
    const c = client(server.port);
    try {
      c.send({ op: 'clone', id: '1' });
      const sid = (await c.next())['new-session'];

      // Scope eval once.
      c.send({ op: 'eval', id: '2', session: sid, file: FIXTURE, code: 'helper()' });
      await collectUntilDone(c, '2');

      // The original doWork() should still return 101, not be broken by the injection.
      c.send({ op: 'eval', id: '3', session: sid, code: `require(${JSON.stringify(FIXTURE)}).doWork()` });
      const frames = await collectUntilDone(c, '3');
      const val = frames.find((f) => f.value !== undefined)?.value;
      assert.equal(val, '101', 'doWork should still return 101 after scope eval');
    } finally {
      c.close();
    }
  } finally {
    if (server) await server.close();
    child.kill();
  }
});
