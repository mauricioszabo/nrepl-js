// Live-patches function/class/var declarations into an existing script via
// V8's Debugger.setScriptSource ("Live Edit"). When a function body is
// swapped, V8 patches the underlying SharedFunctionInfo in place — every
// existing closure that referenced the function object (including private
// intra-module callers) starts running the new bytecode on its next call.
//
// Limits worth knowing:
//   - Editing a function currently on the call stack is rejected.
//   - Adding closed-over variables in an outer scope can be rejected.
//   - For CJS, replacing `module.exports = …` does not retroactively reach
//     consumers that already captured the previous value; users should patch
//     the function instead, or write to require.cache via Runtime.evaluate.

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const PARSE_OPTS = { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, locations: true };

// Returns the list of top-level declared names if `code` is exclusively a set
// of named top-level declarations (FunctionDeclaration / ClassDeclaration /
// VariableDeclaration). Returns null if the code has anything else.
export function parseAsTopLevelDecls(code) {
  let ast;
  try { ast = acorn.parse(code, PARSE_OPTS); } catch { return null; }
  const decls = [];
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id) {
      decls.push({ kind: 'function', name: node.id.name, node });
    } else if (node.type === 'ClassDeclaration' && node.id) {
      decls.push({ kind: 'class', name: node.id.name, node });
    } else if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.id.type !== 'Identifier') return null;
        decls.push({ kind: 'var', name: d.id.name, node, kindWord: node.kind });
      }
    } else if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      // Treat `export function foo` etc. like the inner decl.
      const inner = node.declaration;
      if (inner.type === 'FunctionDeclaration' && inner.id) decls.push({ kind: 'function', name: inner.id.name, node });
      else if (inner.type === 'ClassDeclaration' && inner.id) decls.push({ kind: 'class', name: inner.id.name, node });
      else if (inner.type === 'VariableDeclaration') {
        for (const d of inner.declarations) {
          if (d.id.type !== 'Identifier') return null;
          decls.push({ kind: 'var', name: d.id.name, node });
        }
      } else return null;
    } else {
      return null;
    }
  }
  return decls.length ? decls : null;
}

// Find the outermost program-body node that declares `name`. Returns the
// AST node (with start/end into `source`) or null if not found.
export function findTopLevelDecl(ast, name) {
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) return node;
    if (node.type === 'ClassDeclaration' && node.id?.name === name) return node;
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.id.type === 'Identifier' && d.id.name === name) return node;
      }
    }
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const inner = node.declaration;
      if ((inner.type === 'FunctionDeclaration' || inner.type === 'ClassDeclaration') && inner.id?.name === name) return node;
      if (inner.type === 'VariableDeclaration') {
        for (const d of inner.declarations) {
          if (d.id.type === 'Identifier' && d.id.name === name) return node;
        }
      }
    }
  }
  return null;
}

// Splice each new declaration into `oldSource`. Existing top-level decls of
// the same name are replaced; new ones are appended. Returns the rewritten
// source. Pure / no I/O.
export function spliceDecls(oldSource, newCode) {
  const decls = parseAsTopLevelDecls(newCode);
  if (!decls) throw new Error('patch form must be one or more named top-level declarations');
  const oldAst = acorn.parse(oldSource, PARSE_OPTS);

  // Collect (start,end,replacement) edits, dedupe by spanning node so we
  // don't double-edit when one VariableDeclaration declares two patched names.
  const seen = new Set();
  const edits = [];
  for (const d of decls) {
    const target = findTopLevelDecl(oldAst, d.name);
    const replacement = newCode.slice(d.node.start, d.node.end);
    if (target) {
      const key = target.start + ':' + target.end;
      if (seen.has(key)) continue;
      seen.add(key);
      edits.push({ start: target.start, end: target.end, replacement });
    } else {
      edits.push({ start: oldSource.length, end: oldSource.length, replacement: '\n' + replacement + '\n' });
    }
  }

  // Apply right-to-left so earlier offsets remain valid.
  edits.sort((a, b) => b.start - a.start);
  let out = oldSource;
  for (const e of edits) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  return out;
}

// Patch one or more top-level decls into the script identified by `scriptId`.
// Returns { status, names, exceptionDetails? } where status is 'Ok' or the
// CDP error status (e.g. 'CompileError', 'BlockedByActiveFunction').
export async function patchScript(cdp, scriptId, code) {
  const decls = parseAsTopLevelDecls(code);
  if (!decls) throw new Error('patch form must be one or more named top-level declarations');

  const { scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId });
  const newSource = spliceDecls(scriptSource, code);
  const res = await cdp.send('Debugger.setScriptSource', { scriptId, scriptSource: newSource });
  return { status: res.status ?? 'Ok', names: decls.map((d) => d.name), exceptionDetails: res.exceptionDetails };
}
