import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAsTopLevelDecls, spliceDecls } from '../src/patch.js';

test('parseAsTopLevelDecls accepts function/class/var', () => {
  const decls = parseAsTopLevelDecls('function a(){} class B {} const c = 1;');
  assert.deepEqual(decls.map((d) => [d.kind, d.name]), [['function', 'a'], ['class', 'B'], ['var', 'c']]);
});

test('parseAsTopLevelDecls rejects expressions', () => {
  assert.equal(parseAsTopLevelDecls('1+1'), null);
  assert.equal(parseAsTopLevelDecls('a()'), null);
});

test('parseAsTopLevelDecls accepts export decls', () => {
  const decls = parseAsTopLevelDecls('export function foo(){}');
  assert.deepEqual(decls.map((d) => d.name), ['foo']);
});

test('spliceDecls replaces existing function in place', () => {
  const before = 'function helper(){ return 1 }\nexports.doWork = () => helper() + 100\n';
  const after = spliceDecls(before, 'function helper(){ return 999 }');
  assert.match(after, /function helper\(\)\{ return 999 \}/);
  assert.match(after, /exports\.doWork = \(\) => helper\(\) \+ 100/);
  assert.doesNotMatch(after, /return 1/);
});

test('spliceDecls appends a brand-new decl', () => {
  const before = 'function a(){}\n';
  const after = spliceDecls(before, 'function b(){ return 2 }');
  assert.match(after, /function a\(\)\{\}/);
  assert.match(after, /function b\(\)\{ return 2 \}/);
});

test('spliceDecls handles multiple decls in one patch', () => {
  const before = 'function a(){return 1}\nfunction b(){return 2}\n';
  const after = spliceDecls(before, 'function a(){return 11}\nfunction b(){return 22}');
  assert.match(after, /function a\(\)\{return 11\}/);
  assert.match(after, /function b\(\)\{return 22\}/);
});
