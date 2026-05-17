# nrepl-js

An [nREPL](https://nrepl.org/) server for Node.js, backed by the V8 Inspector
(`node --inspect`). Any nREPL client (Calva, CIDER, vim-iced, custom tooling)
can connect over TCP and drive a live Node process.

Highlights:

- Standard nREPL bencode-over-TCP wire protocol — talks to existing clients.
- Backed by the Chrome DevTools Protocol, so you get real Node semantics
  (top-level `await`, REPL mode redeclarations, full V8).
- `console.log` / `console.error` from the inspected process are streamed back
  as nREPL `out` / `err` messages.
- **Live function patching**: redefine a function (even an unexported one)
  inside an already-loaded module and existing call sites pick up the new
  implementation immediately, without losing module state.

## Usage

Start your app with the inspector enabled:

```sh
node --inspect=9229 your-app.js
```

In another terminal, start the nREPL server:

```sh
npx nrepl-js --port 7888 --inspect-port 9229
# nREPL server listening on 127.0.0.1:7888 (attached to inspector 127.0.0.1:9229)
```

Connect any nREPL client to `127.0.0.1:7888`. A `.nrepl-port` file is written
to the current directory for editor auto-discovery.

Convenience: spawn the inspected process for you:

```sh
nrepl-js --spawn ./your-app.js --port 7888
```

## Live patching

The interesting trick. Send an `eval` op with a `file` field set to the
absolute path of a loaded source file, where `code` is one or more named
top-level declarations (`function`, `class`, `let`/`const`/`var`). nrepl-js
will splice the new declarations into that file's source and apply the change
through V8's `Debugger.setScriptSource`.

V8 swaps the underlying `SharedFunctionInfo` in place, so every existing
`JSFunction` reference — including private intra-module callers captured by
closure — runs the new bytecode on its next call. No module re-require, no
state loss.

Example. Given `foo.cjs`:

```js
function helper() { return 1; }
exports.doWork = function () { return helper() + 100; };
```

Sending `eval` with `file: "/abs/path/foo.cjs"` and
`code: "function helper(){ return 999 }"` makes `doWork()` return `1099`,
even though `helper` was never exported.

### Limits

- Editing a function currently on the call stack is rejected by V8.
- Adding a closed-over variable to an outer scope is usually rejected.
- For CommonJS modules, replacing `module.exports = …` does not retroactively
  reach consumers that already captured the previous value. Patch the
  function directly, or assign to `require.cache[id].exports.foo` from the
  REPL.

## Supported nREPL ops

`clone`, `close`, `describe`, `eval`, `ls-sessions`, `interrupt`, `load-file`.

## Development

```sh
npm install
npm test
```

The test suite includes a full integration test that spawns `node --inspect`,
attaches the server, and exercises eval, console capture, and live patching
end-to-end.

## License

MIT
