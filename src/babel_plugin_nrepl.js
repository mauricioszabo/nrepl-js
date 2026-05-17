// Babel plugin that instruments function entries to expose original parameter
// names at runtime, even after esbuild/Vite renames them.
//
// Each instrumented function gets a watch-point at its body start:
//   ((globalThis.__lazuli ??= {watchPoints:{}}).watchPoints[file] ??= {})[line] =
//     function(code) {
//       return new Function('originalName1', 'originalName2', ...,
//                           'return (' + code + ')')(param1, param2, ...);
//     };
//
// String literals ('originalName1' etc.) survive minification; the identifier
// references (param1 etc.) get renamed by esbuild but still hold the right values.
// This lets the nREPL server evaluate `props.model` even when `props` was renamed to `e`.

export default function babelPluginNrepl({ types: t }) {
  // Collect all bound identifier names from a parameter pattern.
  function collectParamBindings(node) {
    if (!node) return [];
    if (t.isIdentifier(node)) return [node.name];
    if (t.isObjectPattern(node)) {
      return node.properties.flatMap((prop) => {
        if (t.isRestElement(prop)) return collectParamBindings(prop.argument);
        // prop.value is the binding side (what becomes the local variable)
        return collectParamBindings(prop.value);
      });
    }
    if (t.isArrayPattern(node)) {
      return node.elements.flatMap((el) => {
        if (!el) return [];
        if (t.isRestElement(el)) return collectParamBindings(el.argument);
        return collectParamBindings(el);
      });
    }
    if (t.isAssignmentPattern(node)) return collectParamBindings(node.left);
    if (t.isRestElement(node)) return collectParamBindings(node.argument);
    return [];
  }

  // Build: new Function('name1', 'name2', ..., 'return (' + code + ')')(id1, id2, ...)
  function buildNewFunctionCall(names, codeParam) {
    const stringArgs = names.map((n) => t.stringLiteral(n));
    const idArgs = names.map((n) => t.identifier(n));
    const bodyExpr = t.binaryExpression(
      '+',
      t.binaryExpression('+', t.stringLiteral('return ('), codeParam),
      t.stringLiteral(')')
    );
    return t.callExpression(
      t.newExpression(t.identifier('Function'), [...stringArgs, bodyExpr]),
      idArgs
    );
  }

  // Build the watch-point assignment expression:
  //   ((globalThis.__lazuli ??= {watchPoints:{}}).watchPoints[file] ??= {})[line] =
  //     function(code) { return new Function(...)(id1, id2, ...); }
  function buildWatchPointAssignment(filename, line0, names) {
    const codeId = t.identifier('code');

    // globalThis.__lazuli ??= { watchPoints: {} }
    const lazuliInit = t.assignmentExpression(
      '??=',
      t.memberExpression(t.identifier('globalThis'), t.identifier('__lazuli')),
      t.objectExpression([
        t.objectProperty(t.identifier('watchPoints'), t.objectExpression([])),
      ])
    );

    // (...).watchPoints[file] ??= {}
    const fileInit = t.assignmentExpression(
      '??=',
      t.memberExpression(
        t.memberExpression(t.parenthesizedExpression(lazuliInit), t.identifier('watchPoints')),
        t.stringLiteral(filename),
        true
      ),
      t.objectExpression([])
    );

    // (...)[line] = function(code) { return new Function(...)(ids); }
    const watchFn = t.functionExpression(
      null,
      [codeId],
      t.blockStatement([
        t.returnStatement(buildNewFunctionCall(names, codeId)),
      ])
    );

    return t.assignmentExpression(
      '=',
      t.memberExpression(
        t.parenthesizedExpression(fileInit),
        t.numericLiteral(line0),
        true
      ),
      watchFn
    );
  }

  // Build the per-file marker:
  //   (globalThis.__lazuli ??= {}).babelFiles ??= new Set();
  //   globalThis.__lazuli.babelFiles.add(filename);
  function buildFileMarker(filename) {
    const lazuliInit = t.assignmentExpression(
      '??=',
      t.memberExpression(t.identifier('globalThis'), t.identifier('__lazuli')),
      t.objectExpression([])
    );
    const babelFilesInit = t.expressionStatement(
      t.assignmentExpression(
        '??=',
        t.memberExpression(
          t.parenthesizedExpression(lazuliInit),
          t.identifier('babelFiles')
        ),
        t.newExpression(t.identifier('Set'), [])
      )
    );
    const addCall = t.expressionStatement(
      t.callExpression(
        t.memberExpression(
          t.memberExpression(
            t.memberExpression(t.identifier('globalThis'), t.identifier('__lazuli')),
            t.identifier('babelFiles')
          ),
          t.identifier('add')
        ),
        [t.stringLiteral(filename)]
      )
    );
    return [babelFilesInit, addCall];
  }

  function instrumentFunction(path, state) {
    const filename = state.filename || '<unknown>';
    const params = path.node.params;
    if (!params || params.length === 0) return;

    const names = params.flatMap(collectParamBindings);
    if (names.length === 0) return;

    // Capture line number BEFORE potentially replacing the body (replacement loses loc)
    const loc = path.node.body.loc || path.node.loc;
    if (!loc) return;
    const line0 = loc.start.line - 1; // 0-indexed, matches tracing.cljs (dec line)

    // Arrow functions with expression body: wrap in block first
    if (!t.isBlockStatement(path.node.body)) {
      path.get('body').replaceWith(
        t.blockStatement([t.returnStatement(path.node.body)])
      );
    }

    const bodyPath = path.get('body');
    const assignment = t.expressionStatement(
      buildWatchPointAssignment(filename, line0, names)
    );

    bodyPath.unshiftContainer('body', assignment);
  }

  return {
    visitor: {
      Program: {
        enter(path, state) {
          const filename = state.filename || '<unknown>';
          const markers = buildFileMarker(filename);
          // Prepend file marker statements
          path.unshiftContainer('body', markers);
        },
      },
      FunctionDeclaration(path, state) { instrumentFunction(path, state); },
      FunctionExpression(path, state) { instrumentFunction(path, state); },
      ArrowFunctionExpression(path, state) { instrumentFunction(path, state); },
      ClassMethod(path, state) { instrumentFunction(path, state); },
      ObjectMethod(path, state) { instrumentFunction(path, state); },
    },
  };
}
