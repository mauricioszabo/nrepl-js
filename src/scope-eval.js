// Evaluate an arbitrary expression inside the lexical scope of an
// already-loaded module, giving access to private (non-exported) variables.
//
// How it works
// ============
// We set a one-shot breakpoint at the first executable statement of an
// exported function in the target script, call that function via
// Runtime.evaluate to trigger the pause, then use Debugger.evaluateOnCallFrame
// to evaluate the user's expression. The call frame's scope chain includes the
// full module scope — so private module-level variables (functions, consts,
// etc.) are reachable just like they are from within the module.
//
// After the eval we remove the breakpoint and resume.
//
// This approach avoids the alternative of injecting eval() into compiled
// functions, which V8 rejects: adding a nested eval to a function whose
// closure variables were compiled as stack slots (not heap contexts) fails
// silently in setScriptSource — eval requires heap-allocated scopes.
//
// Limitations
// ===========
// - Variables that are local to the triggered function (not module-level)
//   are visible too, but only at the pause point (before any assignment).
// - The target function is briefly called with no arguments; any immediate
//   throw is swallowed. Functions with required side-effectful arguments
//   may not reach the first statement.
// - Pauses the Node.js process for the duration of the eval (~milliseconds).

import * as acorn from 'acorn';
import path from 'node:path';

const PARSE_OPTS = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  locations: true,
};

const PAUSE_TIMEOUT_MS = 5000;

export async function scopeEval({ cdp, scriptId, filePath, code }) {
  const { scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId });
  const ast = acorn.parse(scriptSource, PARSE_OPTS);

  const target = findTarget(ast);
  if (!target) {
    throw new Error(
      'scope eval needs at least one exported function to use as pause point; ' +
      'none found in ' + filePath
    );
  }

  const bpLocation = pauseLocation(target);

  // Set the breakpoint.
  const bpRes = await cdp.send('Debugger.setBreakpoint', { location: { scriptId, ...bpLocation } });
  const breakpointId = bpRes.breakpointId;

  let paused = false;
  let evalResult;
  try {
    // Wire up the pause listener BEFORE triggering the call so we can't miss it.
    const pausePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(
          `scope eval timed out: breakpoint in '${path.basename(filePath)}' was not hit within ${PAUSE_TIMEOUT_MS}ms. ` +
          `Make sure the target function ('${target.name}') is callable.`
        ));
      }, PAUSE_TIMEOUT_MS);

      const off = cdp.on('Debugger.paused', (p) => {
        if (!p.hitBreakpoints?.includes(breakpointId)) return;
        clearTimeout(timer);
        off();
        resolve(p);
      });
    });

    // Call the function (fire-and-forget; it will block on the inspector side
    // until we resume, so we must not await it here).
    const callExpr = buildCallExpr(filePath, target);
    cdp.send('Runtime.evaluate', {
      expression: `try{(${callExpr})}catch(__e){}`,
      replMode: true,
      includeCommandLineAPI: true,
      awaitPromise: false,
    }).catch(() => {});

    const pauseEvent = await pausePromise;
    paused = true;

    const callFrameId = pauseEvent.callFrames[0]?.callFrameId;
    if (!callFrameId) throw new Error('no call frame at pause point');

    evalResult = await cdp.send('Debugger.evaluateOnCallFrame', {
      callFrameId,
      expression: code,
      objectGroup: 'nrepl',
      generatePreview: true,
      returnByValue: false,
      throwOnSideEffect: false,
    });
  } finally {
    await cdp.send('Debugger.removeBreakpoint', { breakpointId }).catch(() => {});
    if (paused) await cdp.send('Debugger.resume').catch(() => {});
  }

  return evalResult;
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Returns true when `node` is a function/arrow with at least one breakable statement.
function hasBreakableBody(node) {
  if (!node) return false;
  if (node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration') {
    return node.body?.type === 'BlockStatement' && node.body.body.length > 0;
  }
  if (node.type === 'ArrowFunctionExpression') {
    return (node.body?.type === 'BlockStatement' && node.body.body.length > 0) ||
           node.body?.type !== 'BlockStatement'; // concise arrow — expression itself is breakable
  }
  return false;
}

function findTarget(ast) {
  for (const node of ast.body) {
    // CJS: exports.foo = fn   OR   module.exports.foo = fn
    if (
      node.type === 'ExpressionStatement' &&
      node.expression.type === 'AssignmentExpression' &&
      node.expression.left.type === 'MemberExpression' &&
      node.expression.left.property.type === 'Identifier'
    ) {
      const obj = node.expression.left.object;
      const exportName = node.expression.left.property.name;
      const rhs = node.expression.right;
      const isExports = obj.type === 'Identifier' && obj.name === 'exports';
      const isModuleExportsProp = (
        obj.type === 'MemberExpression' &&
        obj.object.type === 'Identifier' && obj.object.name === 'module' &&
        obj.property.type === 'Identifier' && obj.property.name === 'exports'
      );
      if ((isExports || isModuleExportsProp) && hasBreakableBody(rhs)) {
        return { kind: 'cjs', exportName, name: exportName, fn: rhs };
      }
    }

    // ESM: export function foo() {}   OR   export const foo = () => {}
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const decl = node.declaration;
      if (decl.type === 'FunctionDeclaration' && decl.id && hasBreakableBody(decl)) {
        return { kind: 'esm', exportName: decl.id.name, name: decl.id.name, fn: decl };
      }
      if (decl.type === 'VariableDeclaration') {
        for (const vd of decl.declarations) {
          if (vd.id?.type === 'Identifier' && hasBreakableBody(vd.init)) {
            return { kind: 'esm', exportName: vd.id.name, name: vd.id.name, fn: vd.init };
          }
        }
      }
    }
  }

  return null;
}

function pauseLocation(target) {
  const body = target.fn.body;
  if (body.type === 'BlockStatement' && body.body.length > 0) {
    const first = body.body[0];
    return { lineNumber: first.loc.start.line - 1, columnNumber: first.loc.start.column };
  }
  // Concise arrow body — the expression itself is breakable.
  return { lineNumber: body.loc.start.line - 1, columnNumber: body.loc.start.column };
}

function buildCallExpr(filePath, target) {
  const key = JSON.stringify(target.exportName);
  const path = JSON.stringify(filePath);
  if (target.kind === 'esm') {
    // Fire-and-forget async IIFE so import() doesn't block Runtime.evaluate.
    return `(async()=>{try{const __m=await import(${path});__m[${key}]()}catch(__e){}})()`;
  }
  return `require(${path})[${key}]()`;
}
