import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../src/bencode.js';

test('encode integers', () => {
  assert.equal(encode(0).toString(), 'i0e');
  assert.equal(encode(42).toString(), 'i42e');
  assert.equal(encode(-7).toString(), 'i-7e');
});

test('encode strings', () => {
  assert.equal(encode('').toString(), '0:');
  assert.equal(encode('hi').toString(), '2:hi');
  // utf-8 length is byte length, not codepoint count
  assert.equal(encode('é').toString(), '2:é');
});

test('encode lists and dicts; dict keys sorted', () => {
  assert.equal(encode([1, 'a']).toString(), 'li1e1:ae');
  assert.equal(encode({ b: 2, a: 1 }).toString(), 'd1:ai1e1:bi2ee');
});

test('decode primitives', () => {
  assert.deepEqual(decode(Buffer.from('i42e')), { value: 42, rest: Buffer.alloc(0) });
  assert.deepEqual(decode(Buffer.from('3:foo')), { value: 'foo', rest: Buffer.alloc(0) });
});

test('decode list and dict', () => {
  assert.deepEqual(decode(Buffer.from('li1e1:ae')).value, [1, 'a']);
  assert.deepEqual(decode(Buffer.from('d1:ai1e1:bi2ee')).value, { a: 1, b: 2 });
});

test('decode returns null when buffer is incomplete', () => {
  assert.equal(decode(Buffer.from('3:fo')), null);
  assert.equal(decode(Buffer.from('i42')), null);
  assert.equal(decode(Buffer.from('d1:ai1e')), null);
});

test('decode preserves trailing bytes as rest', () => {
  const buf = Buffer.concat([Buffer.from('i1e'), Buffer.from('i2e')]);
  const r = decode(buf);
  assert.equal(r.value, 1);
  assert.equal(r.rest.toString(), 'i2e');
});

test('round-trip nrepl-shaped message', () => {
  const msg = { id: '1', op: 'eval', code: '1+1', session: 'abc' };
  const decoded = decode(encode(msg));
  assert.deepEqual(decoded.value, msg);
  assert.equal(decoded.rest.length, 0);
});
