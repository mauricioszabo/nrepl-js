import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { discover } from '../src/inspector.js';
import { connect } from '../src/cdp.js';

test('discover + evaluate 1+1 against node --inspect', async () => {
  const child = spawn(process.execPath, ['--inspect=0', '-e', 'setInterval(()=>{}, 1e9)'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString('utf8');
        const m = buf.match(/Debugger listening on ws:\/\/[^:]+:(\d+)/);
        if (m) { child.stderr.off('data', onData); resolve(Number(m[1])); }
      };
      child.stderr.on('data', onData);
      child.once('exit', (code) => reject(new Error('node exited early: ' + code)));
      setTimeout(() => reject(new Error('timeout waiting for inspector port')), 4000);
    });

    const ws = await discover({ port });
    const cdp = await connect(ws);
    try {
      await cdp.send('Runtime.enable');
      const res = await cdp.send('Runtime.evaluate', { expression: '1+1', returnByValue: true });
      assert.equal(res.result.value, 2);
    } finally {
      cdp.close();
    }
  } finally {
    child.kill();
  }
});
